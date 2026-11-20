import YAML from "yaml";
import { isTruthyFlag } from "./facts.mjs";
import { extractImageRegistry } from "./from-code.mjs";
import { isHelmTemplate, hasChartAncestor } from "./scan.mjs";

const WORKLOAD_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
  "Pod",
  "ReplicationController"
]);

export function isK8sManifest(filePath = "", content = "", obj = null) {
  if (obj && typeof obj === "object" && typeof obj.apiVersion === "string" && typeof obj.kind === "string") {
    return true;
  }
  if (typeof content !== "string") return false;
  // A JSON manifest: kubectl apply reads a .json whose object has apiVersion and kind.
  if (/\.json$/i.test(filePath)) {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
          typeof parsed.apiVersion === "string" && typeof parsed.kind === "string") {
        return true;
      }
    } catch {
      // Not JSON: fall through to the YAML text checks below.
    }
  }
  const isYaml = /\.ya?ml$/i.test(filePath) || filePath.includes("k8s") || filePath.includes("manifest");
  if (!isYaml && !/^\s*apiVersion\s*:/m.test(content)) return false;

  return /^\s*apiVersion\s*:/m.test(content) && /^\s*kind\s*:/m.test(content);
}

export function parseK8sFacts(filePath, content, getStableId, entities, relations, errors, skipped, parseErrors, fullPath = null, rootDir = null, addedCharts = null) {
  if (isHelmTemplate(filePath, content, fullPath, rootDir, addedCharts)) {
    const reason = "Helm template: render with `helm template` and scan the output";
    errors.push({
      file: filePath,
      message: reason,
      reason,
      skipped: true
    });
    if (Array.isArray(skipped)) {
      skipped.push({ path: filePath, reason, helmChart: hasChartAncestor(fullPath, rootDir, addedCharts) });
    }
    return { skipped: true, reason };
  }

  let docObjects = [];

  if (typeof content === "object" && content !== null) {
    if (Array.isArray(content)) {
      docObjects = content.map((c, i) => ({ doc: c, line: i + 1 }));
    } else {
      docObjects = [{ doc: content, line: 1 }];
    }
  } else if (typeof content === "string") {
    const lineOffsets = [0];
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) lineOffsets.push(i + 1);
    }
    function getLine(offset) {
      if (offset == null || offset < 0) return 1;
      let low = 0, high = lineOffsets.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineOffsets[mid] <= offset) low = mid + 1;
        else high = mid - 1;
      }
      return high + 1;
    }

    try {
      const parsedDocs = YAML.parseAllDocuments(content, { logLevel: "error", merge: true });
      for (const parsedDoc of parsedDocs) {
        if (!parsedDoc) continue;
        if (parsedDoc.errors && parsedDoc.errors.length > 0) {
          const pErr = parsedDoc.errors[0];
          const line = parsedDoc.range ? getLine(parsedDoc.range[0]) : (pErr.linePos?.[0]?.line || 1);
          const errEntry = {
            file: filePath,
            path: filePath,
            line,
            error: pErr.message,
            message: `Failed to parse Kubernetes YAML in ${filePath}: ${pErr.message}`
          };
          errors.push(errEntry);
          if (Array.isArray(parseErrors)) parseErrors.push(errEntry);
          return false;
        }
        let json;
        try {
          json = parsedDoc.toJSON();
        } catch (err) {
          const line = parsedDoc.range ? getLine(parsedDoc.range[0]) : 1;
          const errEntry = {
            file: filePath,
            path: filePath,
            line,
            error: err.message,
            message: `Failed to parse Kubernetes YAML in ${filePath}: ${err.message}`
          };
          errors.push(errEntry);
          if (Array.isArray(parseErrors)) parseErrors.push(errEntry);
          return false;
        }
        if (!json || typeof json !== "object" || Array.isArray(json)) continue;
        const line = parsedDoc.range ? getLine(parsedDoc.range[0]) : 1;
        docObjects.push({ doc: json, line });
      }
    } catch (err) {
      const errEntry = {
        file: filePath,
        path: filePath,
        line: 1,
        error: err.message,
        message: `Failed to parse Kubernetes YAML in ${filePath}: ${err.message}`
      };
      errors.push(errEntry);
      if (Array.isArray(parseErrors)) parseErrors.push(errEntry);
      return false;
    }
  }

  // kind: List wraps other objects; each item is its own document (and may itself be a List).
  const expandList = (list) => {
    for (const { doc: docObj, line: docLine } of list) {
      if (docObj && typeof docObj === "object" && !Array.isArray(docObj) &&
          String(docObj.kind).trim() === "List" && Array.isArray(docObj.items)) {
        expandList(docObj.items.map(item => ({ doc: item, line: docLine })));
      } else {
        flatDocs.push({ doc: docObj, line: docLine });
      }
    }
  };
  const flatDocs = [];
  expandList(docObjects);

  for (const { doc: docObj, line: docLine } of flatDocs) {
    if (!docObj || typeof docObj !== "object" || Array.isArray(docObj)) continue;
    if (typeof docObj.apiVersion !== "string" || typeof docObj.kind !== "string") continue;

    const kind = String(docObj.kind).trim();
    const metadata = (docObj.metadata && typeof docObj.metadata === "object") ? docObj.metadata : {};
    const name = String(metadata.name || "").trim();
    const generateName = String(metadata.generateName || "").trim();
    if (!name && !generateName) continue;
    const nameToUse = name || generateName;
    const namespace = String(metadata.namespace || "default").trim() || "default";

    // 1. Workloads
    if (WORKLOAD_KINDS.has(kind)) {
      const workloadSource = { file: filePath, line: docLine };
      const workloadId = `${kind}/${namespace}/${nameToUse}`;

      entities.push({
        kind: "k8s.workload",
        id: workloadId,
        name: nameToUse,
        source: workloadSource,
        attrs: {
          kind,
          name: nameToUse,
          namespace
        }
      });

      // Locate podSpec
      let podSpec = null;
      if (kind === "Pod") {
        podSpec = docObj.spec;
      } else if (kind === "ReplicationController") {
        podSpec = docObj.spec?.template?.spec;
      } else if (kind === "CronJob") {
        podSpec = docObj.spec?.jobTemplate?.spec?.template?.spec || docObj.spec?.template?.spec;
      } else {
        // Deployment, StatefulSet, DaemonSet, ReplicaSet, Job
        podSpec = docObj.spec?.template?.spec;
      }

      if (podSpec && typeof podSpec === "object") {
        const podHostNetwork = Boolean(podSpec.hostNetwork === true || podSpec.hostNetwork === "true");
        const podHostPID = Boolean(podSpec.hostPID === true || podSpec.hostPID === "true");

        let podRunAsNonRoot = null;
        if (podSpec.securityContext?.runAsNonRoot != null) {
          podRunAsNonRoot = Boolean(podSpec.securityContext.runAsNonRoot === true || podSpec.securityContext.runAsNonRoot === "true");
        }

        let podRunAsUser = null;
        if (podSpec.securityContext?.runAsUser != null && !isNaN(Number(podSpec.securityContext.runAsUser))) {
          podRunAsUser = Number(podSpec.securityContext.runAsUser);
        }

        // HostPath volumes in pod
        const hostPathMap = new Map();
        const podHostPaths = [];
        if (Array.isArray(podSpec.volumes)) {
          for (const v of podSpec.volumes) {
            if (v && v.hostPath && v.hostPath.path != null) {
              const p = String(v.hostPath.path);
              if (v.name) hostPathMap.set(v.name, p);
              if (!podHostPaths.includes(p)) podHostPaths.push(p);
            }
          }
        }

        const rawContainers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
        const rawInitContainers = Array.isArray(podSpec.initContainers) ? podSpec.initContainers : [];
        const allContainers = [...rawContainers, ...rawInitContainers];

        for (const c of allContainers) {
          if (!c || typeof c !== "object") continue;
          const cName = String(c.name || "").trim() || "container";
          const image = typeof c.image === "string" ? c.image.trim() : "";
          const registry = extractImageRegistry(image);

          const privileged = isTruthyFlag(c.securityContext?.privileged);
          const allowPrivilegeEscalation = Boolean(c.securityContext?.allowPrivilegeEscalation === true || c.securityContext?.allowPrivilegeEscalation === "true");

          let runAsNonRoot = false;
          const runAsNonRootSet = c.securityContext?.runAsNonRoot != null || podRunAsNonRoot !== null;
          if (c.securityContext?.runAsNonRoot != null) {
            runAsNonRoot = Boolean(c.securityContext.runAsNonRoot === true || c.securityContext.runAsNonRoot === "true");
          } else if (podRunAsNonRoot !== null) {
            runAsNonRoot = podRunAsNonRoot;
          }

          let runAsUser = null;
          if (c.securityContext?.runAsUser != null && !isNaN(Number(c.securityContext.runAsUser))) {
            runAsUser = Number(c.securityContext.runAsUser);
          } else if (podRunAsUser !== null) {
            runAsUser = podRunAsUser;
          }

          const capAdd = [];
          const rawCaps = c.securityContext?.capabilities?.add || c.securityContext?.capabilities?.Add;
          if (Array.isArray(rawCaps)) {
            for (const cap of rawCaps) {
              if (cap != null) {
                const str = String(cap).trim();
                if (str && !capAdd.includes(str)) capAdd.push(str);
              }
            }
          }

          const hostPathMounts = [];
          if (Array.isArray(c.volumeMounts)) {
            for (const vm of c.volumeMounts) {
              if (vm && vm.name && hostPathMap.has(vm.name)) {
                const hp = hostPathMap.get(vm.name);
                if (!hostPathMounts.includes(hp)) hostPathMounts.push(hp);
              }
            }
          } else if (podHostPaths.length > 0) {
            for (const hp of podHostPaths) {
              if (!hostPathMounts.includes(hp)) hostPathMounts.push(hp);
            }
          }

          const hasCpuLimit = Boolean(c.resources?.limits?.cpu != null && String(c.resources.limits.cpu).trim() !== "");
          const hasMemoryLimit = Boolean(c.resources?.limits?.memory != null && String(c.resources.limits.memory).trim() !== "");

          const envNames = [];
          if (Array.isArray(c.env)) {
            for (const e of c.env) {
              if (e && e.name) {
                const en = String(e.name).trim();
                if (en && !envNames.includes(en)) envNames.push(en);
              }
            }
          } else if (c.env && typeof c.env === "object") {
            for (const en of Object.keys(c.env)) {
              const clean = String(en).trim();
              if (clean && !envNames.includes(clean)) envNames.push(clean);
            }
          }

          const containerId = `${kind}/${namespace}/${nameToUse}/${cName}`;
          entities.push({
            kind: "k8s.container",
            id: containerId,
            name: cName,
            source: workloadSource,
            attrs: {
              workload: nameToUse,
              name: cName,
              image,
              registry,
              privileged,
              allowPrivilegeEscalation,
              runAsNonRoot,
              runAsNonRootSet,
              runAsUser,
              capAdd,
              hostNetwork: podHostNetwork,
              hostPID: podHostPID,
              hostPathMounts,
              hasCpuLimit,
              hasMemoryLimit,
              envNames
            }
          });
        }
      }
      continue;
    }

    // 2. Services
    if (kind === "Service") {
      const serviceSource = { file: filePath, line: docLine };
      const serviceId = `Service/${namespace}/${nameToUse}`;
      const type = String(docObj.spec?.type || "ClusterIP").trim() || "ClusterIP";
      const ports = Array.isArray(docObj.spec?.ports) ? docObj.spec.ports : [];

      entities.push({
        kind: "k8s.service",
        id: serviceId,
        name: nameToUse,
        source: serviceSource,
        attrs: {
          name: nameToUse,
          namespace,
          type,
          ports
        }
      });
      continue;
    }

    // 3. Ingress
    if (kind === "Ingress") {
      const ingressSource = { file: filePath, line: docLine };
      const ingressId = `Ingress/${namespace}/${nameToUse}`;

      const hosts = [];
      if (Array.isArray(docObj.spec?.rules)) {
        for (const r of docObj.spec.rules) {
          if (r && r.host) {
            const h = String(r.host).trim();
            if (h && !hosts.includes(h)) hosts.push(h);
          }
        }
      }
      if (Array.isArray(docObj.spec?.tls)) {
        for (const t of docObj.spec.tls) {
          if (Array.isArray(t?.hosts)) {
            for (const h of t.hosts) {
              const hs = String(h).trim();
              if (hs && !hosts.includes(hs)) hosts.push(hs);
            }
          }
        }
      }
      if (Array.isArray(docObj.spec?.hosts)) {
        for (const h of docObj.spec.hosts) {
          const hs = String(h).trim();
          if (hs && !hosts.includes(hs)) hosts.push(hs);
        }
      }

      const tls = Boolean(
        (Array.isArray(docObj.spec?.tls) && docObj.spec.tls.length > 0) ||
        docObj.spec?.tls === true
      );

      entities.push({
        kind: "k8s.ingress",
        id: ingressId,
        name: nameToUse,
        source: ingressSource,
        attrs: {
          name: nameToUse,
          namespace,
          hosts,
          tls
        }
      });
      continue;
    }

    // Unknown kinds are ignored
  }
}
