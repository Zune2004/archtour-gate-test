import YAML from "yaml";

function plural(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

// Code-to-Diagram Auto-Generators
// Automatically extracts architecture diagrams from:
// 1. Prisma Schemas (schema.prisma) -> Entity-Relationship & Data Model Diagram
// 2. Docker Compose (docker-compose.yml) -> Microservices & Network Topology Diagram
// 3. OpenAPI / Swagger (openapi.json, openapi.yaml) -> API Gateway & Endpoint Service Flow

// ---------------------------------------------------------------- Prisma Parser
export function parsePrismaSchema(src) {
  if (!src || typeof src !== "string") throw new Error("Prisma schema source must be a string");

  const models = new Map();
  const rawLines = src.split(/\r?\n/);

  let currentModel = null;
  for (const rawLine of rawLines) {
    const ln = rawLine.trim();
    if (!ln || ln.startsWith("//") || ln.startsWith("#") || ln.startsWith("@@")) continue;

    const modelMatch = ln.match(/^model\s+([A-Za-z0-9_-]+)\s*\{/i);
    if (modelMatch) {
      const name = modelMatch[1];
      currentModel = { name, fields: [], relations: [] };
      models.set(name, currentModel);
      continue;
    }

    if (ln === "}") {
      currentModel = null;
      continue;
    }

    if (currentModel) {
      const fieldMatch = ln.match(/^([A-Za-z0-9_-]+)\s+([A-Za-z0-9_\[\]\?]+)(.*)$/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        let fieldType = fieldMatch[2];
        const extra = fieldMatch[3] || "";
        const isList = fieldType.endsWith("[]");
        const cleanType = fieldType.replace(/[\[\]\?]/g, "");

        currentModel.fields.push({
          name: fieldName,
          type: fieldType,
          cleanType,
          isPk: extra.includes("@id"),
          isUnique: extra.includes("@unique"),
          hasDefault: extra.includes("@default"),
          hasRelationAttr: extra.includes("@relation"),
          relationTarget: null,
          attrs: []
        });

        currentModel.relations.push({
          fieldName,
          targetType: cleanType,
          isList,
          isRelation: false
        });
      }
    }
  }

  if (models.size === 0) {
    throw new Error("No Prisma models found in source file");
  }

  const modelNames = new Set(models.keys());
  const nodes = [];
  const edges = [];
  const seenEdges = new Set();
  const seenIds = new Set();
  const modelNameToId = new Map();

  for (const name of models.keys()) {
    let baseId = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "model";
    let id = baseId;
    if (seenIds.has(id)) {
      let counter = 2;
      while (seenIds.has(`${baseId}-${counter}`)) {
        counter++;
      }
      id = `${baseId}-${counter}`;
      console.warn(`Warning: duplicate model id "${baseId}" for "${name}", renamed to "${id}"`);
    }
    seenIds.add(id);
    modelNameToId.set(name, id);
    if (!modelNameToId.has(name.toLowerCase())) {
      modelNameToId.set(name.toLowerCase(), id);
    }
  }

  for (const [name, model] of models.entries()) {
    const id = modelNameToId.get(name) || name.toLowerCase();
    // Populate relation target and machine-readable attrs for each field
    for (const f of model.fields) {
      if (modelNames.has(f.cleanType) && f.cleanType !== name) {
        f.relationTarget = f.cleanType;
      }
      const attrs = [];
      if (f.isPk) attrs.push("id");
      if (f.isUnique) attrs.push("unique");
      if (f.hasDefault) attrs.push("default");
      if (f.relationTarget) attrs.push(f.relationTarget);
      f.attrs = attrs;
    }

    // Label: Model name, then up to 6 field lines `name: Type` with markers (`🔑` for @id, `name → Type` for relations), then `+N more` if longer
    const maxLabelFields = 6;
    const labelLines = [name];
    const displayedFields = model.fields.slice(0, maxLabelFields);
    for (const f of displayedFields) {
      if (f.relationTarget) {
        labelLines.push(`${f.name} → ${f.type}`);
      } else if (f.isPk) {
        labelLines.push(`${f.name}: ${f.type} 🔑`);
      } else {
        labelLines.push(`${f.name}: ${f.type}`);
      }
    }
    if (model.fields.length > maxLabelFields) {
      labelLines.push(`+${model.fields.length - maxLabelFields} more`);
    }

    // Detail: Markdown table of ALL fields (Field | Type | Attributes)
    const tableHeader = "| Field | Type | Attributes |\n|---|---|---|";
    const tableRows = model.fields.map(f => {
      const attrDisplay = f.attrs
        .map(a => (a === f.relationTarget ? `→ ${a}` : a))
        .join(", ");
      return `| ${f.name} | ${f.type} | ${attrDisplay} |`;
    }).join("\n");
    const detail = `### ${name} Model\n\n${tableHeader}\n${tableRows}`;

    nodes.push({
      id,
      name,
      originalName: name,
      label: labelLines.join("\n"),
      shape: "rectangle",
      color: "blue",
      tooltip: `${model.fields.length} ${plural(model.fields.length, "field")}`,
      detail,
      fields: model.fields.map(f => ({
        name: f.name,
        type: f.type,
        attrs: f.attrs
      }))
    });

    for (const rel of model.relations) {
      if (modelNames.has(rel.targetType) && rel.targetType !== name) {
        const from = id;
        const to = modelNameToId.get(rel.targetType) || rel.targetType.toLowerCase();
        const reciprocalKey = `${to}->${from}`;

        if (seenEdges.has(reciprocalKey)) {
          const existing = edges.find(e => e.from === to && e.to === from);
          if (existing && rel.isList) {
            existing.from = from;
            existing.to = to;
            existing.label = "1 : N";
          }
          continue;
        }

        const edgeKey = `${from}->${to}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({
            from,
            to,
            label: rel.isList ? "1 : N" : "1 : 1",
            style: "solid",
            arrow: "end"
          });
        }
      }
    }
  }

  return {
    title: "Database Data Models",
    direction: "LR",
    preset: "clean",
    nodes,
    edges
  };
}

// ---------------------------------------------------------------- Docker Compose Parser
export function parseDockerCompose(src) {
  if (!src || typeof src !== "string") throw new Error("Docker Compose source must be a string");

  let parsed;
  try {
    parsed = YAML.parse(src, { merge: true, logLevel: "error" });
  } catch (err) {
    throw new Error(`Failed to parse Docker Compose YAML: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || !parsed.services || typeof parsed.services !== "object") {
    throw new Error("No Docker Compose services found in source file");
  }

  const serviceEntries = Object.entries(parsed.services);
  if (serviceEntries.length === 0) {
    throw new Error("No Docker Compose services found in source file");
  }

  const nodes = [];
  const edges = [];
  const seenIds = new Set();
  const sNameToId = new Map();

  for (const [sName] of serviceEntries) {
    let baseId = sName.toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "service";
    let id = baseId;
    if (seenIds.has(id)) {
      let counter = 2;
      while (seenIds.has(`${baseId}-${counter}`)) {
        counter++;
      }
      id = `${baseId}-${counter}`;
      console.warn(`Warning: duplicate service id "${baseId}" for "${sName}", renamed to "${id}"`);
    }
    seenIds.add(id);
    sNameToId.set(sName, id);
    if (!sNameToId.has(sName.toLowerCase())) {
      sNameToId.set(sName.toLowerCase(), id);
    }
  }

  for (const [sName, rawSvc] of serviceEntries) {
    const id = sNameToId.get(sName);
    const svc = (rawSvc && typeof rawSvc === "object") ? rawSvc : {};

    // 1. image
    let image = "";
    if (typeof svc.image === "string") {
      image = svc.image.trim();
    }

    // 2. build
    let build = "";
    if (typeof svc.build === "string") {
      build = svc.build.trim();
    } else if (svc.build && typeof svc.build === "object") {
      if (svc.build.context) build = String(svc.build.context).trim();
      else if (svc.build.dockerfile) build = String(svc.build.dockerfile).trim();
    }

    // 3. ports
    const ports = [];
    if (Array.isArray(svc.ports)) {
      for (const p of svc.ports) {
        if (p == null) continue;
        let portStr = "";
        if (typeof p === "string" || typeof p === "number") {
          portStr = String(p).trim();
        } else if (typeof p === "object") {
          portStr = p.published ? `${p.published}:${p.target}` : String(p.target || "");
        }
        if (portStr && !ports.includes(portStr)) {
          ports.push(portStr);
        }
      }
    }

    // 4. volumes
    const volumes = [];
    if (Array.isArray(svc.volumes)) {
      for (const v of svc.volumes) {
        if (v == null) continue;
        let volName = "";
        if (typeof v === "string") {
          volName = v.split(":")[0].trim();
        } else if (typeof v === "object") {
          volName = String(v.source || v.target || "").trim();
        }
        if (volName && !volumes.includes(volName)) {
          volumes.push(volName);
        }
      }
    }

    // 5. environment (NAMES ONLY, NEVER VALUES)
    const envNames = [];
    function addEnvName(name) {
      if (name != null) {
        const clean = String(name).trim();
        if (clean && !envNames.includes(clean)) {
          envNames.push(clean);
        }
      }
    }

    // env_file: string or array of strings/objects
    if (typeof svc.env_file === "string") {
      addEnvName(svc.env_file);
    } else if (Array.isArray(svc.env_file)) {
      for (const ef of svc.env_file) {
        if (typeof ef === "string") {
          addEnvName(ef);
        } else if (ef && typeof ef === "object" && ef.path) {
          addEnvName(ef.path);
        }
      }
    }

    // environment: array of KEY=VALUE strings or map/object
    if (Array.isArray(svc.environment)) {
      for (const item of svc.environment) {
        if (item == null) continue;
        const str = String(item).trim();
        const key = str.split("=")[0].trim();
        addEnvName(key);
      }
    } else if (svc.environment && typeof svc.environment === "object") {
      for (const key of Object.keys(svc.environment)) {
        addEnvName(key);
      }
    }

    // 6. depends_on (short list, map form with condition, inline map)
    const dependsOn = [];
    function addDep(d) {
      if (d != null) {
        const clean = String(d).trim();
        if (clean && !dependsOn.includes(clean)) {
          dependsOn.push(clean);
        }
      }
    }
    if (Array.isArray(svc.depends_on)) {
      for (const dep of svc.depends_on) {
        if (typeof dep === "string") {
          addDep(dep);
        } else if (dep && typeof dep === "object" && dep.service) {
          addDep(dep.service);
        }
      }
    } else if (svc.depends_on && typeof svc.depends_on === "object") {
      for (const dep of Object.keys(svc.depends_on)) {
        addDep(dep);
      }
    } else if (typeof svc.depends_on === "string") {
      addDep(svc.depends_on);
    }

    // 7. links
    const links = [];
    function addLink(l) {
      if (l != null) {
        const target = String(l).split(":")[0].trim();
        if (target && !links.includes(target)) {
          links.push(target);
        }
      }
    }
    if (Array.isArray(svc.links)) {
      for (const l of svc.links) {
        if (typeof l === "string") {
          addLink(l);
        }
      }
    } else if (svc.links && typeof svc.links === "object") {
      for (const l of Object.keys(svc.links)) {
        addLink(l);
      }
    } else if (typeof svc.links === "string") {
      addLink(svc.links);
    }

    const isDb = /(postgres|mysql|mariadb|mongo|redis|database|sqlite|cockroach)/i.test(sName + " " + image);
    const isGateway = /(nginx|caddy|traefik|proxy|gateway|ingress)/i.test(sName + " " + image);

    let shape = "rectangle";
    let color = "violet";
    if (isDb) {
      shape = "ellipse";
      color = "green";
    } else if (isGateway) {
      shape = "rectangle";
      color = "blue";
    }

    // Machine-readable fields array: image, build, port mappings, volume names, env var names (NO VALUES)
    const fields = [];
    if (image) {
      fields.push({ name: "image", type: image, attrs: [] });
    }
    if (build) {
      fields.push({ name: "build", type: build, attrs: [] });
    }
    for (const p of ports) {
      fields.push({ name: p, type: "port", attrs: [] });
    }
    for (const v of volumes) {
      fields.push({ name: v, type: "volume", attrs: [] });
    }
    for (const e of envNames) {
      fields.push({ name: e, type: "env", attrs: [] });
    }

    // Detail: image/build, ports, volumes, env var names
    const detailLines = [`### Service: ${sName}`];
    if (image) {
      detailLines.push(`- **Image:** \`${image}\``);
    } else if (build) {
      detailLines.push(`- **Build:** \`${build}\``);
    } else {
      detailLines.push(`- **Image:** \`custom build\``);
    }
    detailLines.push(`- **Ports:** ${ports.length ? ports.map(p => `\`${p}\``).join(", ") : "none"}`);
    detailLines.push(`- **Volumes:** ${volumes.length ? volumes.map(v => `\`${v}\``).join(", ") : "none"}`);
    detailLines.push(`- **Environment:** ${envNames.length ? envNames.map(e => `\`${e}\``).join(", ") : "none"}`);

    nodes.push({
      id,
      name: sName,
      originalName: sName,
      label: sName + (image ? `\n(${image.split(":")[0]})` : (build ? `\n(${build})` : "")),
      shape,
      color,
      tooltip: image ? `Image: ${image}` : `Service: ${sName}`,
      detail: detailLines.join("\n"),
      fields
    });

    const targetSet = new Set();
    for (const dep of dependsOn) {
      const target = sNameToId.get(dep) || sNameToId.get(dep.toLowerCase()) || dep.toLowerCase();
      if (!targetSet.has(target)) {
        targetSet.add(target);
        edges.push({
          from: id,
          to: target,
          label: "depends on",
          style: "solid"
        });
      }
    }

    for (const link of links) {
      const target = sNameToId.get(link) || sNameToId.get(link.toLowerCase()) || link.toLowerCase();
      if (!targetSet.has(target)) {
        targetSet.add(target);
        edges.push({
          from: id,
          to: target,
          label: "links",
          style: "solid"
        });
      }
    }
  }

  return {
    title: "Container Infrastructure",
    direction: "TB",
    preset: "blueprint",
    nodes,
    edges
  };
}

// ---------------------------------------------------------------- OpenAPI Parser
export function parseOpenApi(src) {
  let doc;
  if (typeof src === "object" && src !== null) {
    doc = src;
  } else if (typeof src === "string") {
    try {
      doc = JSON.parse(src);
    } catch {
      try {
        doc = YAML.parse(src, { merge: true, logLevel: "error" });
      } catch (yamlErr) {
        throw new Error(`OpenAPI specification must be valid JSON or YAML: ${yamlErr.message}`);
      }
    }
  } else {
    throw new Error("OpenAPI specification must be a string or object");
  }

  if (!doc || typeof doc !== "object") {
    throw new Error("OpenAPI specification must be a valid JSON or YAML object");
  }

  const title = doc?.info?.title || "API Architecture";
  const paths = doc?.paths || {};
  const tagsMap = new Map();

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [method, op] of Object.entries(pathItem)) {
      if (!op || typeof op !== "object") continue;
      if (!["get", "post", "put", "delete", "patch"].includes(method.toLowerCase())) continue;

      let tags = ["General"];
      if (Array.isArray(op.tags) && op.tags.length > 0) {
        tags = op.tags.map(t => (t != null ? String(t).trim() : "")).filter(Boolean);
        if (!tags.length) tags = ["General"];
      } else if (op.tags != null && !Array.isArray(op.tags)) {
        const t = String(op.tags).trim();
        tags = t ? [t] : ["General"];
      }
      for (const t of tags) {
        if (!tagsMap.has(t)) tagsMap.set(t, []);
        tagsMap.get(t).push({
          method: method.toUpperCase(),
          path: pathStr,
          summary: op.summary || pathStr,
          operationId: op.operationId || ""
        });
      }
    }
  }

  if (tagsMap.size === 0) {
    throw new Error("No endpoints found in OpenAPI specification");
  }

  const nodes = [];
  const edges = [];

  // Client node
  nodes.push({
    id: "client",
    name: "client",
    originalName: "client",
    label: "Client App",
    shape: "ellipse",
    color: "blue",
    tooltip: "Web, Mobile, or CLI client",
    detail: "Consumes REST API endpoints",
    fields: []
  });

  // Gateway node
  nodes.push({
    id: "gateway",
    name: "gateway",
    originalName: "gateway",
    label: "API Gateway",
    shape: "diamond",
    color: "orange",
    tooltip: "Routing, SSL, and Rate Limiting",
    detail: "Routes incoming HTTP requests to specialized service controllers",
    fields: []
  });

  edges.push({
    from: "client",
    to: "gateway",
    label: "HTTPS",
    style: "solid"
  });

  const seenIds = new Set(["client", "gateway"]);
  for (const [rawTag, endpoints] of tagsMap.entries()) {
    const tag = String(rawTag);
    let baseId = tag.toLowerCase().replace(/[^a-z0-9_-]/g, "_") || "tag";
    let tagId = baseId;
    if (seenIds.has(tagId)) {
      let counter = 2;
      while (seenIds.has(`${baseId}-${counter}`)) {
        counter++;
      }
      tagId = `${baseId}-${counter}`;
      console.warn(`Warning: duplicate node id "${baseId}" for tag "${tag}", renamed to "${tagId}"`);
    }
    seenIds.add(tagId);

    // Machine-readable fields array: one entry per route: { name: "GET /orders", type: operationId or "" }
    const fields = endpoints.map(e => ({
      name: `${e.method} ${e.path}`,
      type: e.operationId || "",
      attrs: []
    }));

    // Detail lists its routes (`GET /orders/{id}` - summary)
    const routeList = endpoints.map(e => {
      return e.summary ? `- \`${e.method} ${e.path}\` - ${e.summary}` : `- \`${e.method} ${e.path}\``;
    }).join("\n");

    nodes.push({
      id: tagId,
      name: tag,
      originalName: tag,
      label: `${tag}\n(${endpoints.length} ${plural(endpoints.length, "route")})`,
      shape: "rectangle",
      color: "violet",
      tooltip: `${endpoints.length} ${plural(endpoints.length, "endpoint")} under ${tag}`,
      detail: `### ${tag} Controller\n\n**Routes:**\n${routeList}`,
      fields
    });

    edges.push({
      from: "gateway",
      to: tagId,
      label: `/${tagId}`,
      style: "solid"
    });
  }

  return {
    title,
    direction: "LR",
    preset: "clean",
    nodes,
    edges
  };
}

// ---------------------------------------------------------------- Helpers for Architecture Facts & Discovery
export function extractImageRegistry(image) {
  if (!image || typeof image !== "string") return "";
  const clean = image.trim();
  if (!clean) return "";
  const parts = clean.split("/");
  if (parts.length > 1) {
    const first = parts[0];
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      return first;
    }
  }
  return "docker.io";
}

export function isPrismaSource(src, filename = "") {
  return /\.prisma$/i.test(filename) || (/model\s+[A-Za-z0-9_-]+\s*\{/i.test(src) && !/version\s*:/i.test(src));
}

export function isDockerComposeSource(src, filename = "") {
  return /^(?:docker-compose.*|compose.*)\.ya?ml$/i.test(filename) ||
    (/\.ya?ml$/i.test(filename) && /^\s*services\s*:/m.test(src));
}

export function isOpenApiSource(src, filename = "") {
  return (
    (/\.ya?ml$/i.test(filename) && (/^(?:openapi.*|swagger.*)\.ya?ml$/i.test(filename) || /^\s*(?:openapi|swagger)\s*:/m.test(src))) ||
    (/\.json$/i.test(filename) && (/^(?:openapi.*|swagger.*)\.json$/i.test(filename) || /"openapi"\s*:|"swagger"\s*:/i.test(src)))
  );
}

