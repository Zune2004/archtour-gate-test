import { diffSqlFacts } from "./facts-sql.mjs";

import { diffGraphQL } from "./facts-graphql.mjs";
import { diffProto } from "./facts-proto.mjs";
import { diffTerraformFacts } from "./facts-terraform.mjs";

// Risk-attribute events that may be emitted for newly added entities (safe defaults)
export const RISK_ATTRIBUTE_EVENTS = [
  "service.privileged_enabled",
  "service.host_network_enabled",
  "service.docker_socket_mounted",
  "service.host_mount_added",
  "service.port_published",
  "compose.port_exposed",
  "service.registry_changed",
  "k8s.privileged_enabled",
  "k8s.privilege_escalation_allowed",
  "k8s.run_as_root",
  "k8s.host_network_enabled",
  "k8s.host_pid_enabled",
  "k8s.host_path_added",
  "k8s.capability_added",
  "k8s.limits_missing_new",
  "k8s.registry_changed",
  "k8s.service_exposed",
  "k8s.ingress_tls_removed",
  "k8s.ingress_host_added",
  "api.security_removed",
  "api.route_public"
];

// Change-only events that must NEVER fire for newly added entities (only existing entities)
export const CHANGE_ONLY_EVENTS = [
  "db.field_made_required",
  "db.field_type_changed",
  "db.field_unique_added",
  "service.image_changed",
  "sql.type_narrowed",
  "sql.not_null_without_default",
  "proto.field_number_changed"
];

// Whether a k8s container may run as root, and how to say it. runAsUser > 0 is never root. "Not set" is reported honestly:
// the image's USER applies, which is often root (Pod Security "restricted" requires runAsNonRoot: true).
function runAsRootState(attrs) {
  if (attrs.runAsUser === 0) return { after: "runAsUser: 0", text: "runs as root (runAsUser: 0)" };
  if (typeof attrs.runAsUser === "number" && attrs.runAsUser > 0) return null;
  if (attrs.runAsNonRoot === true) return null;
  if (attrs.runAsNonRootSet === false) {
    return { after: "runAsNonRoot: not set", text: "does not set runAsNonRoot (the image's user, often root, applies)" };
  }
  return { after: "runAsNonRoot: false", text: "sets runAsNonRoot: false (may run as root)" };
}

export function diffFacts(base = {}, head = {}) {
  const isTruncated = Boolean(base?.truncated || head?.truncated);
  const events = [];

  const baseEntities = new Map((base?.entities || []).map(e => [e.id, e]));
  const headEntities = new Map((head?.entities || []).map(e => [e.id, e]));

  // Collect parse errors from base or head
  const allParseErrors = [...(base?.parseErrors || []), ...(head?.parseErrors || [])];
  const failedFiles = new Set(allParseErrors.map(e => e.file || e.path).filter(Boolean));

  const baseParseErrors = base?.parseErrors || [];
  const headParseErrors = head?.parseErrors || [];
  const baseSources = base?.sources || [];

  const normPath = p => (p || "").replace(/\\/g, "/");
  const baseSourcesMap = new Map(baseSources.map(s => [normPath(s.path), s]));
  const baseParseErrorsMap = new Map(baseParseErrors.map(e => [normPath(e.file || e.path), e]));

  for (const hErr of headParseErrors) {
    const fPath = hErr.file || hErr.path;
    const normF = normPath(fPath);
    const errSource = { file: fPath, line: hErr.line || 1 };
    const errDetail = hErr.error || hErr.message || "Parse error";

    if (baseSourcesMap.has(normF)) {
      events.push({
        type: "parse.error_head",
        entityId: `file:${fPath}`,
        kind: "file",
        source: errSource,
        after: errDetail,
        error: errDetail,
        message: `File '${fPath}' parsed in base but failed to parse in head: ${errDetail}`
      });
    } else if (baseParseErrorsMap.has(normF)) {
      events.push({
        type: "parse.error_unchanged",
        entityId: `file:${fPath}`,
        kind: "file",
        source: errSource,
        before: baseParseErrorsMap.get(normF)?.error || baseParseErrorsMap.get(normF)?.message,
        after: errDetail,
        error: errDetail,
        message: `File '${fPath}' failed to parse in both base and head: ${errDetail}`
      });
    } else {
      events.push({
        type: "parse.error_new_file",
        entityId: `file:${fPath}`,
        kind: "file",
        source: errSource,
        after: errDetail,
        error: errDetail,
        message: `New file '${fPath}' failed to parse: ${errDetail}`
      });
    }
  }

  function isFromFileWithParseError(source) {
    if (!source?.file) return false;
    if (failedFiles.has(source.file)) return true;
    const sNorm = source.file.replace(/\\/g, "/");
    const sDir = sNorm.includes("/") ? sNorm.slice(0, sNorm.lastIndexOf("/")) : ".";
    for (const ff of failedFiles) {
      const fNorm = ff.replace(/\\/g, "/");
      const fDir = fNorm.includes("/") ? fNorm.slice(0, fNorm.lastIndexOf("/")) : ".";
      if (sDir === fDir) return true;
    }
    return false;
  }

  // P1/P2: Prisma model & field rename detection
  const modelRenames = new Map();
  const renamedModelIds = new Set();
  const fieldRenames = new Map();
  const renamedFieldIds = new Set();

  if (!isTruncated) {
    const baseModels = Array.from(baseEntities.values()).filter(e => e.kind === "db.model");
    const headModels = Array.from(headEntities.values()).filter(e => e.kind === "db.model");
    const removedBaseModels = baseModels.filter(bm => !headEntities.has(bm.id));
    const addedHeadModels = headModels.filter(hm => !baseEntities.has(hm.id));

    for (const hm of addedHeadModels) {
      if (hm.attrs?.mappedTable) {
        const bm = removedBaseModels.find(b => (b.attrs?.mappedTable || b.attrs?.tableName || b.name) === hm.attrs.mappedTable);
        if (bm) {
          modelRenames.set(bm.name, hm);
          renamedModelIds.add(hm.id);
          renamedModelIds.add(bm.id);
          events.push({
            type: "db.model_renamed",
            entityId: hm.id,
            kind: "db.model",
            before: bm.name,
            after: hm.name,
            source: hm.source,
            message: `Database model '${bm.name}' was renamed to '${hm.name}'`
          });
        }
      }
    }

    const baseFields = Array.from(baseEntities.values()).filter(e => e.kind === "db.field");
    const headFields = Array.from(headEntities.values()).filter(e => e.kind === "db.field");
    const removedBaseFields = baseFields.filter(bf => !headEntities.has(bf.id));
    const addedHeadFields = headFields.filter(hf => !baseEntities.has(hf.id));

    for (const hf of addedHeadFields) {
      if (hf.attrs?.mappedColumn) {
        let targetBaseModelName = hf.attrs?.model;
        for (const [oldName, newModel] of modelRenames.entries()) {
          if (newModel.name === hf.attrs?.model) {
            targetBaseModelName = oldName;
            break;
          }
        }
        const bf = removedBaseFields.find(b =>
          b.attrs?.model === targetBaseModelName &&
          (b.attrs?.mappedColumn || b.attrs?.columnName || b.attrs?.name) === hf.attrs.mappedColumn
        );
        if (bf) {
          fieldRenames.set(bf.id, hf);
          renamedFieldIds.add(hf.id);
          renamedFieldIds.add(bf.id);
          events.push({
            type: "db.field_renamed",
            entityId: hf.id,
            kind: "db.field",
            before: `${bf.attrs?.model}.${bf.attrs?.name}`,
            after: `${hf.attrs?.model}.${hf.attrs?.name}`,
            source: hf.source,
            message: `Database field '${bf.attrs?.model}.${bf.attrs?.name}' was renamed to '${hf.attrs?.model}.${hf.attrs?.name}'`
          });
        }
      }
    }

    // Also suppress removal of fields in a renamed model that kept their column name
    for (const bf of removedBaseFields) {
      if (renamedFieldIds.has(bf.id)) continue;
      if (modelRenames.has(bf.attrs?.model)) {
        const newModel = modelRenames.get(bf.attrs?.model);
        const bCol = bf.attrs?.mappedColumn || bf.attrs?.columnName || bf.attrs?.name;
        const matchingHeadField = headFields.find(h =>
          h.attrs?.model === newModel.name &&
          (h.attrs?.mappedColumn || h.attrs?.columnName || h.attrs?.name) === bCol
        );
        if (matchingHeadField) {
          renamedFieldIds.add(bf.id);
          renamedFieldIds.add(matchingHeadField.id);
        }
      }
    }
  }

  // Track removed model IDs to suppress field_removed for fields of removed models
  const removedModelNames = new Set();
  if (!isTruncated) {
    for (const [id, baseEnt] of baseEntities.entries()) {
      if (!headEntities.has(id) && baseEnt.kind === "db.model" && !renamedModelIds.has(id)) {
        removedModelNames.add(baseEnt.name);
      }
    }
  }

  // 1. Added Entities (only when not truncated)
  if (!isTruncated) {
    for (const [id, headEnt] of headEntities.entries()) {
      if (!baseEntities.has(id)) {
        if (renamedModelIds.has(id) || renamedFieldIds.has(id)) {
          // Handled by rename events above
          continue;
        }
        if (headEnt.kind === "api.route") {
          events.push({
            type: "api.route_added",
            entityId: headEnt.id,
            kind: headEnt.kind,
            after: headEnt.name,
            source: headEnt.source,
            message: `API route '${headEnt.name}' was added`
          });
        } else if (headEnt.kind === "gql.field" || headEnt.kind === "proto.field" || headEnt.kind === "proto.package") {
          // Suppress generic entity.added for fields / package
        } else {
          events.push({
            type: "entity.added",
            entityId: headEnt.id,
            kind: headEnt.kind,
            after: headEnt.name,
            source: headEnt.source,
            message: `${headEnt.kind} '${headEnt.name}' was added`
          });
        }

        const source = headEnt.source;
        const hAttrs = headEnt.attrs || {};

        // 1. Compose Service safe defaults
        if (headEnt.kind === "service") {
          if (hAttrs.privileged) {
            events.push({
              type: "service.privileged_enabled",
              entityId: id,
              kind: "service",
              before: null,
              after: true,
              new: true,
              source,
              message: `New service '${headEnt.name}' enabled privileged mode`
            });
          }
          if (hAttrs.networkModeHost) {
            events.push({
              type: "service.host_network_enabled",
              entityId: id,
              kind: "service",
              before: null,
              after: true,
              new: true,
              source,
              message: `New service '${headEnt.name}' enabled host network mode`
            });
          }
          if (hAttrs.dockerSocket) {
            events.push({
              type: "service.docker_socket_mounted",
              entityId: id,
              kind: "service",
              before: null,
              after: true,
              new: true,
              source,
              message: `New service '${headEnt.name}' mounted docker socket`
            });
          }
          const hMounts = Array.isArray(hAttrs.hostMounts) ? hAttrs.hostMounts : [];
          for (const m of hMounts) {
            events.push({
              type: "service.host_mount_added",
              entityId: id,
              kind: "service",
              before: null,
              after: m,
              new: true,
              source,
              message: `New service '${headEnt.name}' added host mount '${m}'`
            });
          }
          const hPorts = Array.isArray(hAttrs.ports) ? hAttrs.ports : [];
          for (const hp of hPorts) {
            if (hp && hp.published && hp.bindAll) {
              events.push({
                type: "service.port_published",
                entityId: id,
                kind: "service",
                before: null,
                after: hp,
                new: true,
                source,
                message: `New service '${headEnt.name}' published port ${hp.host}:${hp.container}/${hp.protocol} (all interfaces)`
              });
            }
          }
          if (hAttrs.registry && hAttrs.registry !== "docker.io") {
            events.push({
              type: "service.registry_changed",
              entityId: id,
              kind: "service",
              before: null,
              after: hAttrs.registry,
              new: true,
              source,
              message: `New service '${headEnt.name}' registry changed from 'null' to '${hAttrs.registry}'`
            });
          }
        }

        // 2. Kubernetes Container safe defaults
        if (headEnt.kind === "k8s.container") {
          if (hAttrs.privileged) {
            events.push({
              type: "k8s.privileged_enabled",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: true,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' enabled privileged mode`
            });
          }
          if (hAttrs.allowPrivilegeEscalation) {
            events.push({
              type: "k8s.privilege_escalation_allowed",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: true,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' allowed privilege escalation`
            });
          }
          const rootState = runAsRootState(hAttrs);
          if (rootState) {
            events.push({
              type: "k8s.run_as_root",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: rootState.after,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' ${rootState.text}`
            });
          }
          if (hAttrs.hostNetwork) {
            events.push({
              type: "k8s.host_network_enabled",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: true,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' enabled host network`
            });
          }
          if (hAttrs.hostPID) {
            events.push({
              type: "k8s.host_pid_enabled",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: true,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' enabled host PID`
            });
          }
          const hMounts = Array.isArray(hAttrs.hostPathMounts) ? hAttrs.hostPathMounts : [];
          for (const m of hMounts) {
            events.push({
              type: "k8s.host_path_added",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: m,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' added hostPath mount '${m}'`
            });
          }
          const hCaps = Array.isArray(hAttrs.capAdd) ? hAttrs.capAdd : [];
          for (const c of hCaps) {
            events.push({
              type: "k8s.capability_added",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: c,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' added capability '${c}'`
            });
          }
          if (!hAttrs.hasCpuLimit && !hAttrs.hasMemoryLimit) {
            events.push({
              type: "k8s.limits_missing_new",
              entityId: id,
              kind: "k8s.container",
              before: null,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' has no resource limits`
            });
          }
          if (hAttrs.registry && hAttrs.registry !== "docker.io") {
            events.push({
              type: "k8s.registry_changed",
              entityId: id,
              kind: "k8s.container",
              before: null,
              after: hAttrs.registry,
              new: true,
              source,
              message: `New container '${headEnt.name}' in workload '${hAttrs.workload}' registry changed from 'null' to '${hAttrs.registry}'`
            });
          }
        }

        // 3. Kubernetes Service safe defaults
        if (headEnt.kind === "k8s.service") {
          if (hAttrs.type === "LoadBalancer" || hAttrs.type === "NodePort") {
            events.push({
              type: "k8s.service_exposed",
              entityId: id,
              kind: "k8s.service",
              before: null,
              after: hAttrs.type,
              new: true,
              source,
              message: `New service '${headEnt.name}' exposed as ${hAttrs.type}`
            });
          }
        }

        // 4. Kubernetes Ingress safe defaults
        if (headEnt.kind === "k8s.ingress") {
          if (!hAttrs.tls) {
            events.push({
              type: "k8s.ingress_tls_removed",
              entityId: id,
              kind: "k8s.ingress",
              before: null,
              after: false,
              new: true,
              source,
              message: `New ingress '${headEnt.name}' removed TLS configuration`
            });
          }
          const hHosts = Array.isArray(hAttrs.hosts) ? hAttrs.hosts : [];
          for (const h of hHosts) {
            events.push({
              type: "k8s.ingress_host_added",
              entityId: id,
              kind: "k8s.ingress",
              before: null,
              after: h,
              new: true,
              source,
              message: `New ingress '${headEnt.name}' added host '${h}'`
            });
          }
        }

        // 5. OpenAPI Route safe defaults
        if (headEnt.kind === "api.route") {
          if (!hAttrs.security) {
            events.push({
              type: "api.route_public",
              entityId: id,
              kind: "api.route",
              before: null,
              after: false,
              new: true,
              source,
              message: `New API route '${headEnt.name}' is public (no security)`
            });
          }
        }


      }
    }
  }

  // T-107b: a Prisma schema split across files still knows every model. A field whose type is a model anywhere in the
  // base schema is a relation field, not a column, even when the model lives in another .prisma file.
  const baseModelNames = new Set();
  for (const baseEnt of baseEntities.values()) {
    if (baseEnt.kind === "db.model") baseModelNames.add(baseEnt.name);
  }

  // 2. Removed Entities (only when not truncated)
  if (!isTruncated) {
    for (const [id, baseEnt] of baseEntities.entries()) {
      if (!headEntities.has(id)) {
        if (isFromFileWithParseError(baseEnt.source)) {
          // Base or head side that fails to build -> a parseErrors entry, never "everything removed"
          continue;
        }
        if (baseEnt.kind === "db.model") {
          if (renamedModelIds.has(baseEnt.id)) continue;
          events.push({
            type: "db.model_removed",
            entityId: baseEnt.id,
            kind: baseEnt.kind,
            before: baseEnt.name,
            source: baseEnt.source,
            message: `Database model '${baseEnt.name}' was removed`
          });
        } else if (baseEnt.kind === "db.field") {
          if (renamedFieldIds.has(baseEnt.id)) continue;
          // T-107 (B): Prisma relation fields have no column; removing one (e.g. `posts Post[]`)
          // removes no data. The scalar FK (`authorId`) is a normal field and is still reported.
          if (baseEnt.attrs?.relation === true) continue;
          if (baseEnt.attrs?.type && baseModelNames.has(baseEnt.attrs.type)) continue;
          if (!removedModelNames.has(baseEnt.attrs?.model)) {
            events.push({
              type: "db.field_removed",
              entityId: baseEnt.id,
              kind: baseEnt.kind,
              before: `${baseEnt.attrs?.model}.${baseEnt.attrs?.name}`,
              source: baseEnt.source,
              message: `Database field '${baseEnt.attrs?.model}.${baseEnt.attrs?.name}' was removed`
            });
          }
        } else if (baseEnt.kind === "api.route") {
          // T-103: renaming a path parameter ({id} -> {userId}) does not remove the route.
          const baseRouteKey = String(baseEnt.name).replace(/\{[^}]*\}/g, "{}");
          const sameRouteInHead = [...headEntities.values()].some(
            h => h && h.kind === "api.route" && String(h.name).replace(/\{[^}]*\}/g, "{}") === baseRouteKey
          );
          if (sameRouteInHead) continue;
          events.push({
            type: "api.route_removed",
            entityId: baseEnt.id,
            kind: baseEnt.kind,
            before: baseEnt.name,
            source: baseEnt.source,
            message: `API route '${baseEnt.name}' was removed`
          });
        } else if (baseEnt.kind === "gql.field" || baseEnt.kind === "proto.field" || baseEnt.kind === "proto.service" || baseEnt.kind === "proto.package") {
          // Handled by format-specific events
          continue;
        } else {
          events.push({
            type: "entity.removed",
            entityId: baseEnt.id,
            kind: baseEnt.kind,
            before: baseEnt.name,
            source: baseEnt.source,
            message: `${baseEnt.kind} '${baseEnt.name}' was removed`
          });
        }
      }
    }
  }

  // 3. Modified Entities (entities present in both base and head)
  for (const [id, headEnt] of headEntities.entries()) {
    if (!baseEntities.has(id)) continue;
    const baseEnt = baseEntities.get(id);
    const source = headEnt.source || baseEnt.source;

    // Compose Service checks
    if (headEnt.kind === "service") {
      const bAttrs = baseEnt.attrs || {};
      const hAttrs = headEnt.attrs || {};

      // service.image_changed
      if (bAttrs.image !== hAttrs.image && (bAttrs.image || hAttrs.image)) {
        events.push({
          type: "service.image_changed",
          entityId: id,
          kind: "service",
          before: bAttrs.image,
          after: hAttrs.image,
          source,
          message: `Service '${headEnt.name}' image changed from '${bAttrs.image}' to '${hAttrs.image}'`
        });
      }

      // service.registry_changed
      if (bAttrs.registry !== hAttrs.registry && (bAttrs.registry || hAttrs.registry)) {
        events.push({
          type: "service.registry_changed",
          entityId: id,
          kind: "service",
          before: bAttrs.registry,
          after: hAttrs.registry,
          source,
          message: `Service '${headEnt.name}' registry changed from '${bAttrs.registry}' to '${hAttrs.registry}'`
        });
      }

      // service.privileged_enabled
      if (!bAttrs.privileged && hAttrs.privileged) {
        events.push({
          type: "service.privileged_enabled",
          entityId: id,
          kind: "service",
          before: false,
          after: true,
          source,
          message: `Service '${headEnt.name}' enabled privileged mode`
        });
      }

      // service.host_network_enabled
      if (!bAttrs.networkModeHost && hAttrs.networkModeHost) {
        events.push({
          type: "service.host_network_enabled",
          entityId: id,
          kind: "service",
          before: false,
          after: true,
          source,
          message: `Service '${headEnt.name}' enabled host network mode`
        });
      }

      // service.docker_socket_mounted
      if (!bAttrs.dockerSocket && hAttrs.dockerSocket) {
        events.push({
          type: "service.docker_socket_mounted",
          entityId: id,
          kind: "service",
          before: false,
          after: true,
          source,
          message: `Service '${headEnt.name}' mounted docker socket`
        });
      }

      // service.host_mount_added
      const bMounts = Array.isArray(bAttrs.hostMounts) ? bAttrs.hostMounts : [];
      const hMounts = Array.isArray(hAttrs.hostMounts) ? hAttrs.hostMounts : [];
      for (const m of hMounts) {
        if (!bMounts.includes(m)) {
          events.push({
            type: "service.host_mount_added",
            entityId: id,
            kind: "service",
            after: m,
            source,
            message: `Service '${headEnt.name}' added host mount '${m}'`
          });
        }
      }

      // service.port_published (new published host port on all interfaces) or compose.port_exposed (loopback -> all interfaces)
      const bPorts = Array.isArray(bAttrs.ports) ? bAttrs.ports : [];
      const hPorts = Array.isArray(hAttrs.ports) ? hAttrs.ports : [];
      for (const hp of hPorts) {
        if (hp && hp.published && hp.bindAll) {
          // T-107 (C): the container-side port may change (e.g. "3180:80" -> "3180:${ALT:-80}")
          // without changing what is published. Match on host/hostIp/protocol only, not container.
          // An unspecified host IP (null) is the all-interfaces binding, so it matches any base
          // binding of the same host port; that is how loopback -> all interfaces is still caught.
          const basePortCandidates = bPorts.filter(
            bp => bp && bp.published && bp.host === hp.host && bp.protocol === hp.protocol
          );
          const matchingBasePort = basePortCandidates.find(
            bp => (bp.hostIp || null) === (hp.hostIp || null)
          ) || basePortCandidates.find(bp => bp.bindAll || hp.bindAll);
          if (matchingBasePort) {
            if (!matchingBasePort.bindAll) {
              events.push({
                type: "compose.port_exposed",
                entityId: id,
                kind: "service",
                before: matchingBasePort,
                after: hp,
                source,
                message: `Service '${headEnt.name}' exposed port ${hp.host}:${hp.container}/${hp.protocol} to all interfaces (previously loopback)`
              });
            }
          } else {
            events.push({
              type: "service.port_published",
              entityId: id,
              kind: "service",
              after: hp,
              source,
              message: `Service '${headEnt.name}' published port ${hp.host}:${hp.container}/${hp.protocol} (all interfaces)`
            });
          }
        }
      }
    }

    // Prisma db.field checks
    if (headEnt.kind === "db.field") {
      const bAttrs = baseEnt.attrs || {};
      const hAttrs = headEnt.attrs || {};

      // db.field_type_changed
      if (bAttrs.type !== hAttrs.type) {
        events.push({
          type: "db.field_type_changed",
          entityId: id,
          kind: "db.field",
          before: bAttrs.type,
          after: hAttrs.type,
          source,
          message: `Field '${hAttrs.model}.${hAttrs.name}' type changed from '${bAttrs.type}' to '${hAttrs.type}'`
        });
      }

      // db.field_made_required (optional -> required)
      if (bAttrs.optional && !hAttrs.optional) {
        events.push({
          type: "db.field_made_required",
          entityId: id,
          kind: "db.field",
          before: "optional",
          after: "required",
          source,
          message: `Field '${hAttrs.model}.${hAttrs.name}' was made required (optional -> required)`
        });
      }

      // db.field_unique_added
      if (!bAttrs.unique && hAttrs.unique) {
        events.push({
          type: "db.field_unique_added",
          entityId: id,
          kind: "db.field",
          before: false,
          after: true,
          source,
          message: `Field '${hAttrs.model}.${hAttrs.name}' was made unique`
        });
      }
    }

    // OpenAPI api.route checks
    if (headEnt.kind === "api.route") {
      const bAttrs = baseEnt.attrs || {};
      const hAttrs = headEnt.attrs || {};

      // api.param_required_added
      const bParams = Array.isArray(bAttrs.requiredParams) ? bAttrs.requiredParams : [];
      const hParams = Array.isArray(hAttrs.requiredParams) ? hAttrs.requiredParams : [];
      // T-107 (D): a path parameter is part of the route itself ({orgId} in /orgs/{orgId}), so
      // declaring it required is not a new requirement for clients.
      const routePath = String(headEnt.name || "").split(" ").slice(1).join(" ");
      for (const p of hParams) {
        if (routePath.includes(`{${p}}`)) continue;
        if (!bParams.includes(p)) {
          events.push({
            type: "api.param_required_added",
            entityId: id,
            kind: "api.route",
            after: p,
            source,
            message: `API route '${headEnt.name}' added required parameter '${p}'`
          });
        }
      }

      // api.request_required_added
      const bReq = Array.isArray(bAttrs.requestRequired) ? bAttrs.requestRequired : [];
      const hReq = Array.isArray(hAttrs.requestRequired) ? hAttrs.requestRequired : [];
      for (const reqProp of hReq) {
        if (!bReq.includes(reqProp)) {
          events.push({
            type: "api.request_required_added",
            entityId: id,
            kind: "api.route",
            after: reqProp,
            source,
            message: `API route '${headEnt.name}' added required request body property '${reqProp}'`
          });
        }
      }

      // api.security_removed
      if (bAttrs.security && !hAttrs.security) {
        events.push({
          type: "api.security_removed",
          entityId: id,
          kind: "api.route",
          before: true,
          after: false,
          source,
          message: `API route '${headEnt.name}' removed security`
        });
      }
    }

    // Kubernetes Container checks
    if (headEnt.kind === "k8s.container") {
      const bAttrs = baseEnt.attrs || {};
      const hAttrs = headEnt.attrs || {};

      // k8s.privileged_enabled
      if (!bAttrs.privileged && hAttrs.privileged) {
        events.push({
          type: "k8s.privileged_enabled",
          entityId: id,
          kind: "k8s.container",
          before: false,
          after: true,
          source,
          message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' enabled privileged mode`
        });
      }

      // k8s.privilege_escalation_allowed
      if (!bAttrs.allowPrivilegeEscalation && hAttrs.allowPrivilegeEscalation) {
        events.push({
          type: "k8s.privilege_escalation_allowed",
          entityId: id,
          kind: "k8s.container",
          before: false,
          after: true,
          source,
          message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' allowed privilege escalation`
        });
      }

      // k8s.run_as_root (runAsNonRoot false or runAsUser 0 newly set)
      const headRoot = runAsRootState(hAttrs);
      const runAsRootNewlySet = headRoot && (
        (bAttrs.runAsNonRoot === true && hAttrs.runAsNonRoot === false) ||
        (bAttrs.runAsUser !== 0 && hAttrs.runAsUser === 0));
      if (runAsRootNewlySet) {
        const text = headRoot.after === "runAsNonRoot: not set" ? "no longer sets runAsNonRoot (the image's user, often root, applies)" : headRoot.text;
        events.push({
          type: "k8s.run_as_root",
          entityId: id,
          kind: "k8s.container",
          before: bAttrs.runAsUser === 0 ? "root" : (bAttrs.runAsNonRoot ? "non-root" : "default"),
          after: headRoot.after,
          source,
          message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' ${text}`
        });
      }

      // k8s.host_network_enabled
      if (!bAttrs.hostNetwork && hAttrs.hostNetwork) {
        events.push({
          type: "k8s.host_network_enabled",
          entityId: id,
          kind: "k8s.container",
          before: false,
          after: true,
          source,
          message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' enabled host network`
        });
      }

      // k8s.host_pid_enabled
      if (!bAttrs.hostPID && hAttrs.hostPID) {
        events.push({
          type: "k8s.host_pid_enabled",
          entityId: id,
          kind: "k8s.container",
          before: false,
          after: true,
          source,
          message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' enabled host PID`
        });
      }

      // k8s.host_path_added
      const bMounts = Array.isArray(bAttrs.hostPathMounts) ? bAttrs.hostPathMounts : [];
      const hMounts = Array.isArray(hAttrs.hostPathMounts) ? hAttrs.hostPathMounts : [];
      for (const m of hMounts) {
        if (!bMounts.includes(m)) {
          events.push({
            type: "k8s.host_path_added",
            entityId: id,
            kind: "k8s.container",
            after: m,
            source,
            message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' added hostPath mount '${m}'`
          });
        }
      }

      // k8s.capability_added
      const bCaps = Array.isArray(bAttrs.capAdd) ? bAttrs.capAdd : [];
      const hCaps = Array.isArray(hAttrs.capAdd) ? hAttrs.capAdd : [];
      for (const c of hCaps) {
        if (!bCaps.includes(c)) {
          events.push({
            type: "k8s.capability_added",
            entityId: id,
            kind: "k8s.container",
            after: c,
            source,
            message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' added capability '${c}'`
          });
        }
      }

      // k8s.limits_removed (had a limit, now none)
      const hadLimitInBase = bAttrs.hasCpuLimit || bAttrs.hasMemoryLimit;
      const hasLimitInHead = hAttrs.hasCpuLimit || hAttrs.hasMemoryLimit;
      if (hadLimitInBase && !hasLimitInHead) {
        events.push({
          type: "k8s.limits_removed",
          entityId: id,
          kind: "k8s.container",
          source,
          message: `Container '${headEnt.name}' in workload '${hAttrs.workload}' removed all resource limits`
        });
      }

      // k8s.image_changed
      if (bAttrs.image !== hAttrs.image && (bAttrs.image || hAttrs.image)) {
        events.push({
          type: "k8s.image_changed",
          entityId: id,
          kind: "k8s.container",
          before: bAttrs.image,
          after: hAttrs.image,
          source,
          message: `Container '${headEnt.name}' image changed from '${bAttrs.image}' to '${hAttrs.image}'`
        });
      }

      // k8s.registry_changed
      if (bAttrs.registry !== hAttrs.registry && (bAttrs.registry || hAttrs.registry)) {
        events.push({
          type: "k8s.registry_changed",
          entityId: id,
          kind: "k8s.container",
          before: bAttrs.registry,
          after: hAttrs.registry,
          source,
          message: `Container '${headEnt.name}' registry changed from '${bAttrs.registry}' to '${hAttrs.registry}'`
        });
      }
    }

    // Kubernetes Service checks
    if (headEnt.kind === "k8s.service") {
      const bAttrs = baseEnt.attrs || {};
      const hAttrs = headEnt.attrs || {};

      // k8s.service_exposed (type becomes LoadBalancer or NodePort)
      if (bAttrs.type !== "LoadBalancer" && bAttrs.type !== "NodePort" && (hAttrs.type === "LoadBalancer" || hAttrs.type === "NodePort")) {
        events.push({
          type: "k8s.service_exposed",
          entityId: id,
          kind: "k8s.service",
          before: bAttrs.type || "ClusterIP",
          after: hAttrs.type,
          source,
          message: `Service '${headEnt.name}' exposed as ${hAttrs.type}`
        });
      }
    }

    // Kubernetes Ingress checks
    if (headEnt.kind === "k8s.ingress") {
      const bAttrs = baseEnt.attrs || {};
      const hAttrs = headEnt.attrs || {};

      // k8s.ingress_host_added
      const bHosts = Array.isArray(bAttrs.hosts) ? bAttrs.hosts : [];
      const hHosts = Array.isArray(hAttrs.hosts) ? hAttrs.hosts : [];
      for (const h of hHosts) {
        if (!bHosts.includes(h)) {
          events.push({
            type: "k8s.ingress_host_added",
            entityId: id,
            kind: "k8s.ingress",
            after: h,
            source,
            message: `Ingress '${headEnt.name}' added host '${h}'`
          });
        }
      }

      // k8s.ingress_tls_removed
      if (bAttrs.tls && !hAttrs.tls) {
        events.push({
          type: "k8s.ingress_tls_removed",
          entityId: id,
          kind: "k8s.ingress",
          before: true,
          after: false,
          source,
          message: `Ingress '${headEnt.name}' removed TLS configuration`
        });
      }
    }
  }


  // 4. Relations: service.dependency_added & service.dependency_removed
  const baseDepsByService = new Map();
  for (const r of base?.relations || []) {
    if (r.kind === "service.depends_on") {
      if (!baseDepsByService.has(r.from)) baseDepsByService.set(r.from, new Set());
      baseDepsByService.get(r.from).add(r.to);
    }
  }

  const headDepsByService = new Map();
  for (const r of head?.relations || []) {
    if (r.kind === "service.depends_on") {
      if (!headDepsByService.has(r.from)) headDepsByService.set(r.from, new Set());
      headDepsByService.get(r.from).add(r.to);
    }
  }

  // Check added dependencies
  for (const [sName, hDeps] of headDepsByService.entries()) {
    const bDeps = baseDepsByService.get(sName) || new Set();
    const serviceId = `service:${sName}`;
    const source = headEntities.get(serviceId)?.source;
    for (const dep of hDeps) {
      if (!bDeps.has(dep)) {
        events.push({
          type: "service.dependency_added",
          entityId: serviceId,
          kind: "service",
          after: dep,
          source,
          message: `Service '${sName}' added dependency on '${dep}'`
        });
      }
    }
  }

  // Check removed dependencies
  for (const [sName, bDeps] of baseDepsByService.entries()) {
    const hDeps = headDepsByService.get(sName) || new Set();
    const serviceId = `service:${sName}`;
    const source = headEntities.get(serviceId)?.source || baseEntities.get(serviceId)?.source;
    for (const dep of bDeps) {
      if (!hDeps.has(dep)) {
        events.push({
          type: "service.dependency_removed",
          entityId: serviceId,
          kind: "service",
          before: dep,
          source,
          message: `Service '${sName}' removed dependency on '${dep}'`
        });
      }
    }
  }

  // 5. SQL Migration events
  diffSqlFacts(base, head, events, isTruncated);

  // 5. GraphQL breaking and dangerous changes
  const gqlEvents = diffGraphQL(base, head, baseEntities, headEntities);
  events.push(...gqlEvents);

  // 6. Protobuf events
  const protoEvents = diffProto(base, head, baseEntities, headEntities);
  events.push(...protoEvents);

  // 7. Terraform plan events
  diffTerraformFacts(base, head, events, isTruncated);

  // An added entity is judged only on its risk attributes; "changed" events need a before value
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].new && CHANGE_ONLY_EVENTS.includes(events[i].type)) events.splice(i, 1);
  }

  // Summary
  const eventsByType = {};
  for (const e of events) {
    eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;
  }

  const summary = {
    totalEvents: events.length,
    eventsByType,
    truncated: isTruncated
  };

  const result = {
    events,
    summary
  };

  if (allParseErrors.length > 0) {
    result.parseErrors = allParseErrors;
  }

  return result;
}
