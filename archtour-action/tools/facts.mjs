import crypto from "node:crypto";
import YAML from "yaml";
import { extractImageRegistry } from "./from-code.mjs";
import { getMaxFileBytes, getMaxFileMb } from "./settings.mjs";
export function isTruthyFlag(v) {
  if (typeof v === "boolean") return v === true;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  if (s === "true") return true;
  if (s === "yes" || s === "on" || s === "y") return true;
  // Compose interpolation ${NAME:-DEFAULT} or ${NAME-DEFAULT}: resolve the default and pass it through.
  const interpMatch = s.match(/^\$\{([^}:-]+):?-(.+)\}$/);
  if (interpMatch) {
    const defaultVal = interpMatch[2].trim();
    return isTruthyFlag(defaultVal);
  }
  // Bare ${NAME} with no default: cannot be resolved, so fail closed.
  if (s.startsWith("${") && s.endsWith("}")) {
    return true;
  }
  return false;
}
import { parseSqlFacts, isSqlMigrationCandidate } from "./facts-sql.mjs";
import { parseK8sFacts, isK8sManifest } from "./facts-k8s.mjs";
import { isGraphQLFile, parseGraphQLFacts } from "./facts-graphql.mjs";
import { isProtoFile, parseProtoFacts } from "./facts-proto.mjs";
import { isTerraformPlanJson, parseTerraformPlanFacts } from "./facts-terraform.mjs";
import { isHelmTemplate, hasChartAncestor } from "./scan.mjs";

export { extractImageRegistry };

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createIdRegistry(errors) {
  const seenIds = new Set();
  return function getStableId(kind, name, source) {
    const baseId = `${kind}:${name}`;
    let id = baseId;
    if (seenIds.has(id)) {
      let counter = 2;
      while (seenIds.has(`${baseId}-${counter}`)) {
        counter++;
      }
      id = `${baseId}-${counter}`;
      errors.push({
        message: `Duplicate entity id "${baseId}", renamed to "${id}"`,
        baseId,
        id,
        file: source?.file,
        line: source?.line
      });
    }
    seenIds.add(id);
    return id;
  };
}

function parsePrismaFacts(filePath, content, getStableId, entities, relations, errors) {
  const lines = content.split(/\r?\n/);
  const models = [];
  let currentModel = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    const lineNum = idx + 1;
    const ln = rawLine.trim();
    if (!ln || ln.startsWith("//") || ln.startsWith("#")) continue;

    const modelMatch = ln.match(/^model\s+([A-Za-z0-9_-]+)\s*\{/i);
    if (modelMatch) {
      const name = modelMatch[1];
      currentModel = { name, line: lineNum, fields: [], relations: [], mappedTable: null };
      models.push(currentModel);
      continue;
    }

    if (ln === "}") {
      currentModel = null;
      continue;
    }

    if (currentModel) {
      if (ln.startsWith("@@")) {
        const mapMatch = ln.match(/^@@map\(\s*["']([^"']+)["']\s*\)/i);
        if (mapMatch) {
          currentModel.mappedTable = mapMatch[1];
        }
        continue;
      }

      const fieldMatch = ln.match(/^([A-Za-z0-9_-]+)\s+([A-Za-z0-9_\[\]\?]+)(.*)$/);
      if (fieldMatch) {
        const fieldName = fieldMatch[1];
        const fieldType = fieldMatch[2];
        const extra = fieldMatch[3] || "";
        const isList = fieldType.endsWith("[]");
        const isOptional = fieldType.endsWith("?") || fieldType.includes("?");
        const cleanType = fieldType.replace(/[\[\]\?]/g, "");

        const mapMatch = extra.match(/@map\(\s*["']([^"']+)["']\s*\)/i);
        const mappedColumn = mapMatch ? mapMatch[1] : null;

        currentModel.fields.push({
          name: fieldName,
          type: cleanType,
          rawType: fieldType,
          line: lineNum,
          optional: Boolean(isOptional),
          list: Boolean(isList),
          id: extra.includes("@id"),
          unique: extra.includes("@unique"),
          default: extra.includes("@default"),
          hasRelation: extra.includes("@relation"),
          mappedColumn
        });

        currentModel.relations.push({
          fieldName,
          targetType: cleanType,
          isList,
          line: lineNum
        });
      }
    }
  }

  const modelNames = new Set(models.map(m => m.name));
  const seenEdges = new Set();

  for (const model of models) {
    const modelSource = { file: filePath, line: model.line };
    const modelId = getStableId("db.model", model.name, modelSource);
    const modelAttrs = { name: model.name };
    if (model.mappedTable) {
      modelAttrs.mappedTable = model.mappedTable;
      modelAttrs.tableName = model.mappedTable;
    }
    entities.push({
      kind: "db.model",
      id: modelId,
      name: model.name,
      source: modelSource,
      attrs: modelAttrs
    });

    for (const field of model.fields) {
      const fieldSource = { file: filePath, line: field.line };
      const fieldId = getStableId("db.field", `${model.name}.${field.name}`, fieldSource);
      const fieldAttrs = {
        model: model.name,
        name: field.name,
        type: field.type,
        optional: field.optional,
        list: field.list,
        id: field.id,
        unique: field.unique,
        default: field.default
      };
      if (field.mappedColumn) {
        fieldAttrs.mappedColumn = field.mappedColumn;
        fieldAttrs.columnName = field.mappedColumn;
      }
      // T-107 (B): a field whose type is a model in this schema is a Prisma relation field, not a
      // column; the data lives in the scalar FK field. Enums are not models, so they stay normal fields.
      if (modelNames.has(field.type)) {
        fieldAttrs.relation = true;
      }
      entities.push({
        kind: "db.field",
        id: fieldId,
        name: field.name,
        source: fieldSource,
        attrs: fieldAttrs
      });
    }

    for (const rel of model.relations) {
      if (modelNames.has(rel.targetType) && rel.targetType !== model.name) {
        const from = model.name;
        const to = rel.targetType;
        const reciprocalKey = `${to}->${from}`;

        if (seenEdges.has(reciprocalKey)) {
          const existing = relations.find(r => r.kind === "db.relation" && r.from === to && r.to === from);
          if (existing) {
            if (existing.cardinality === "1:N" && rel.isList) {
              existing.cardinality = "N:M";
            } else if (rel.isList) {
              existing.from = from;
              existing.to = to;
              existing.fromId = `db.model:${from}`;
              existing.toId = `db.model:${to}`;
              existing.cardinality = "1:N";
            }
          }
          continue;
        }

        const edgeKey = `${from}->${to}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          relations.push({
            kind: "db.relation",
            from,
            to,
            cardinality: rel.isList ? "1:N" : "1:1",
            fromId: `db.model:${from}`,
            toId: `db.model:${to}`
          });
        }
      }
    }
  }
}

function isLoopbackIp(hostIp) {
  if (!hostIp) return false;
  const ip = String(hostIp).trim().toLowerCase().replace(/^\[|\]$/g, "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

function isAllInterfacesIp(hostIp) {
  if (!hostIp) return true;
  const ip = String(hostIp).trim().toLowerCase().replace(/^\[|\]$/g, "");
  return ip === "0.0.0.0" || ip === "::" || ip === "";
}

/**
 * Split a string on `delim` characters that appear outside `${...}`
 * interpolations. `${PORT:-8080}:8080` -> ["${PORT:-8080}", "8080"].
 */
function splitOutsideCurly(str, delim) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "$" && str[i + 1] === "{") {
      depth++;
      current += "${";
      i++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      current += "}";
    } else if (ch === delim && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Resolve a compose interpolation token to a concrete string, or null if
 * it cannot be resolved.
 *
 * `${NAME:-DEFAULT}` / `${NAME-DEFAULT}` -> DEFAULT
 * `${NAME}` with no default -> null (unknown)
 */
function resolveComposeInterp(token) {
  // ${NAME:-DEFAULT} or ${NAME-DEFAULT}
  const m = token.match(/^\$\{[^}:-]+:?-.+\}$/);
  if (m) {
    const body = token.slice(2, -1); // strip ${ and }
    const colonIdx = body.indexOf(":-");
    const dashIdx = body.indexOf("-");
    if (colonIdx !== -1 && (dashIdx === -1 || colonIdx < dashIdx)) {
      return body.slice(colonIdx + 2).trim(); // ${NAME:-DEFAULT}
    }
    if (dashIdx !== -1) {
      return body.slice(dashIdx + 1).trim(); // ${NAME-DEFAULT}
    }
  }
  return null;
}

function parseComposePorts(rawPorts) {
  const ports = [];
  if (!Array.isArray(rawPorts)) return ports;

  for (const p of rawPorts) {
    if (p == null) continue;
    if (typeof p === "number") {
      ports.push({
        host: null,
        hostIp: null,
        container: String(p),
        protocol: "tcp",
        published: false,
        bindAll: false
      });
    } else if (typeof p === "string") {
      let str = p.trim();
      let protocol = "tcp";
      if (str.includes("/")) {
        const slashIdx = str.lastIndexOf("/");
        protocol = str.slice(slashIdx + 1).toLowerCase() || "tcp";
        str = str.slice(0, slashIdx);
      }
      const parts = splitOutsideCurly(str, ":");
      if (parts.length === 1) {
        ports.push({
          host: null,
          hostIp: null,
          container: parts[0].trim(),
          protocol,
          published: false,
          bindAll: false
        });
      } else if (parts.length === 2) {
        let hostPart = parts[0].trim();
        const containerPart = parts[1].trim();
        // Resolve interpolation in host port
        if (hostPart.startsWith("${")) {
          const resolved = resolveComposeInterp(hostPart);
          if (resolved !== null) hostPart = resolved;
        }
        const published = hostPart !== "";
        ports.push({
          host: published ? hostPart : null,
          hostIp: null,
          container: containerPart,
          protocol,
          published,
          bindAll: published
        });
      } else if (parts.length === 3) {
        let hostIp = parts[0].trim();
        let hostPart = parts[1].trim();
        const containerPart = parts[2].trim();
        // Resolve interpolation in host IP and host port
        if (hostIp.startsWith("${")) {
          const resolved = resolveComposeInterp(hostIp);
          if (resolved !== null) hostIp = resolved;
          else hostIp = "0.0.0.0"; // unknown host IP -> all interfaces (fail closed)
        }
        if (hostPart.startsWith("${")) {
          const resolved = resolveComposeInterp(hostPart);
          if (resolved !== null) hostPart = resolved;
        }
        const published = hostPart !== "";
        const bindAll = published && isAllInterfacesIp(hostIp) && !isLoopbackIp(hostIp);
        ports.push({
          host: published ? hostPart : null,
          hostIp: hostIp || null,
          container: containerPart,
          protocol,
          published,
          bindAll
        });
      }
    } else if (typeof p === "object") {
      const target = p.target != null ? String(p.target) : "";
      const publishedPort = p.published != null && String(p.published).trim() !== "" ? String(p.published) : null;
      const protocol = (p.protocol || "tcp").toLowerCase();
      const hostIp = p.host_ip ? String(p.host_ip).trim() : "";
      const published = publishedPort !== null;
      const bindAll = published && isAllInterfacesIp(hostIp) && !isLoopbackIp(hostIp);
      ports.push({
        host: publishedPort,
        hostIp: hostIp || null,
        container: target,
        protocol,
        published,
        bindAll
      });
    }
  }
  return ports;
}

// Compose files for local development: a name token dev/development/local/test/testing/override
// (docker-compose.dev.yml, compose.local.yaml, docker-compose.override.yml) or a dev/development/local/.devcontainer folder.
const DEV_COMPOSE_TOKENS = new Set(["dev", "development", "local", "test", "testing", "override"]);
const DEV_COMPOSE_DIRS = new Set(["dev", "development", "local", ".devcontainer"]);

export function isDevComposeFile(filePath) {
  const parts = String(filePath || "").replace(/\\/g, "/").toLowerCase().split("/");
  const basename = parts.pop();
  if (basename.split(/[._-]/).some(t => DEV_COMPOSE_TOKENS.has(t))) return true;
  return parts.some(d => DEV_COMPOSE_DIRS.has(d));
}

function parseComposeFacts(filePath, content, getStableId, entities, relations, errors, parseErrors) {
  const devEnv = isDevComposeFile(filePath) ? "dev" : undefined;
  let doc;
  if (typeof content === "object" && content !== null) {
    doc = content;
  } else {
    try {
      doc = YAML.parse(content, { merge: true, logLevel: "error" });
    } catch (err) {
      const line = err.linePos?.[0]?.line || 1;
      const errEntry = {
        file: filePath,
        path: filePath,
        line,
        error: err.message,
        message: `Failed to parse Docker Compose YAML in ${filePath}: ${err.message}`
      };
      errors.push(errEntry);
      if (Array.isArray(parseErrors)) parseErrors.push(errEntry);
      return false;
    }
  }

  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") {
    return true;
  }

  const lines = typeof content === "string" ? content.split(/\r?\n/) : [];
  const serviceEntries = Object.entries(doc.services);

  for (const [sName, rawSvc] of serviceEntries) {
    const svc = (rawSvc && typeof rawSvc === "object") ? rawSvc : {};

    // Determine line number
    let serviceLine = 1;
    const sRegex = new RegExp(`^\\s*${escapeRegex(sName)}\\s*:`);
    for (let idx = 0; idx < lines.length; idx++) {
      if (sRegex.test(lines[idx])) {
        serviceLine = idx + 1;
        break;
      }
    }

    // 1. image & registry
    let image = "";
    if (typeof svc.image === "string") {
      image = svc.image.trim();
    }
    const registry = extractImageRegistry(image);

    // 2. build
    const build = Boolean(svc.build);

    // 3. privileged
    const privileged = isTruthyFlag(svc.privileged);

    // 4. networkModeHost
    const networkModeHost = Boolean(
      typeof svc.network_mode === "string" && svc.network_mode.trim().toLowerCase() === "host"
    );

    // 5. capAdd
    const capAdd = [];
    if (Array.isArray(svc.cap_add)) {
      for (const c of svc.cap_add) {
        if (c != null) capAdd.push(String(c).trim());
      }
    } else if (typeof svc.cap_add === "string") {
      capAdd.push(svc.cap_add.trim());
    }

    // 6. hostMounts & dockerSocket
    const hostMounts = [];
    let dockerSocket = false;
    const rawVolumes = Array.isArray(svc.volumes) ? svc.volumes : [];

    for (const v of rawVolumes) {
      if (v == null) continue;
      let hostPart = "";
      if (typeof v === "string") {
        const trimmed = v.trim();
        if (trimmed.includes("/var/run/docker.sock") || trimmed.includes("docker.sock")) {
          dockerSocket = true;
        }
        const parts = trimmed.split(":");
        hostPart = parts[0].trim();
      } else if (typeof v === "object") {
        const srcStr = String(v.source || "").trim();
        const tgtStr = String(v.target || "").trim();
        if (srcStr.includes("/var/run/docker.sock") || tgtStr.includes("/var/run/docker.sock") || srcStr.includes("docker.sock")) {
          dockerSocket = true;
        }
        if (v.type === "bind" || srcStr.startsWith("/") || srcStr.startsWith("./") || srcStr.startsWith("../") || srcStr.startsWith("~") || /^[A-Za-z]:[\\/]/.test(srcStr)) {
          hostPart = srcStr;
        }
      }

      if (hostPart) {
        const isBind = hostPart.startsWith("/") || hostPart.startsWith("./") || hostPart.startsWith("../") || hostPart.startsWith("~") || /^[A-Za-z]:[\\/]/.test(hostPart) || hostPart === "." || hostPart === "..";
        if (isBind && !hostMounts.includes(hostPart)) {
          hostMounts.push(hostPart);
        }
      }
    }

    // 7. envNames (NEVER VALUES)
    const envNames = [];
    function addEnv(name) {
      if (name != null) {
        const clean = String(name).trim();
        if (clean && !envNames.includes(clean)) {
          envNames.push(clean);
        }
      }
    }
    if (Array.isArray(svc.environment)) {
      for (const item of svc.environment) {
        if (item == null) continue;
        const key = String(item).split("=")[0].trim();
        addEnv(key);
      }
    } else if (svc.environment && typeof svc.environment === "object") {
      for (const key of Object.keys(svc.environment)) {
        addEnv(key);
      }
    }
    if (typeof svc.env_file === "string") {
      addEnv(svc.env_file);
    } else if (Array.isArray(svc.env_file)) {
      for (const ef of svc.env_file) {
        if (typeof ef === "string") addEnv(ef);
        else if (ef && typeof ef === "object" && ef.path) addEnv(ef.path);
      }
    }

    // 8. ports
    const ports = parseComposePorts(svc.ports);

    const source = { file: filePath, line: serviceLine };
    // Dev compose services get their own id so a dev file never replaces or hides the main service, whatever the file order
    const serviceId = getStableId("service", devEnv ? `${sName}@${String(filePath).replace(/\\/g, "/")}` : sName, source);

    const attrs = {
      name: sName,
      image,
      registry,
      build,
      privileged,
      networkModeHost,
      capAdd,
      hostMounts,
      dockerSocket,
      envNames,
      ports
    };
    if (devEnv) attrs.environment = devEnv;

    entities.push({
      kind: "service",
      id: serviceId,
      name: sName,
      source,
      attrs
    });

    // 9. relations: service.depends_on
    const dependsOn = [];
    function addDep(d) {
      if (d != null) {
        const clean = String(d).trim();
        if (clean && !dependsOn.includes(clean)) dependsOn.push(clean);
      }
    }
    if (Array.isArray(svc.depends_on)) {
      for (const dep of svc.depends_on) {
        if (typeof dep === "string") addDep(dep);
        else if (dep && typeof dep === "object" && dep.service) addDep(dep.service);
      }
    } else if (svc.depends_on && typeof svc.depends_on === "object") {
      for (const dep of Object.keys(svc.depends_on)) {
        addDep(dep);
      }
    } else if (typeof svc.depends_on === "string") {
      addDep(svc.depends_on);
    }

    for (const dep of dependsOn) {
      relations.push({
        kind: "service.depends_on",
        from: sName,
        to: dep,
        fromId: `service:${sName}`,
        toId: `service:${dep}`
      });
    }
  }
}

function parseOpenApiFacts(filePath, content, getStableId, entities, relations, errors, parseErrors) {
  let doc;
  try {
    if (typeof content === "string") {
      try {
        doc = JSON.parse(content);
      } catch {
        doc = YAML.parse(content, { merge: true, logLevel: "error" });
      }
    } else if (typeof content === "object" && content !== null) {
      doc = content;
    }
  } catch (err) {
    const line = err.linePos?.[0]?.line || 1;
    const errEntry = {
      file: filePath,
      path: filePath,
      line,
      error: err.message,
      message: `Failed to parse OpenAPI document in ${filePath}: ${err.message}`
    };
    errors.push(errEntry);
    if (Array.isArray(parseErrors)) parseErrors.push(errEntry);
    return false;
  }

  if (!doc || typeof doc !== "object" || !doc.paths || typeof doc.paths !== "object") {
    return true;
  }

  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;
  const lines = typeof content === "string" ? content.split(/\r?\n/) : [];

  for (const [pathStr, rawPathItem] of Object.entries(doc.paths)) {
    const pathItem = (rawPathItem && typeof rawPathItem === "object") ? rawPathItem : {};
    const pathParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const [rawMethod, rawOp] of Object.entries(pathItem)) {
      const methodLower = rawMethod.toLowerCase();
      if (!["get", "post", "put", "delete", "patch", "options", "head"].includes(methodLower)) {
        continue;
      }
      const method = rawMethod.toUpperCase();
      const op = (rawOp && typeof rawOp === "object") ? rawOp : {};
      const operationId = typeof op.operationId === "string" ? op.operationId : "";
      const tags = Array.isArray(op.tags) ? op.tags.map(String) : [];

      // Determine line number
      let routeLine = 1;
      if (lines.length > 0) {
        const pathRegex = new RegExp(`["']?${escapeRegex(pathStr)}["']?\\s*:`);
        for (let idx = 0; idx < lines.length; idx++) {
          if (pathRegex.test(lines[idx])) {
            routeLine = idx + 1;
            break;
          }
        }
      }

      // requiredParams
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      const allParams = [...pathParams, ...opParams];
      const requiredParams = [];
      for (const p of allParams) {
        if (p && typeof p === "object" && p.name) {
          if (p.required === true || p.in === "path") {
            const pName = String(p.name);
            if (!requiredParams.includes(pName)) requiredParams.push(pName);
          }
        }
      }

      // requestRequired (top-level required body properties)
      const requestRequired = [];
      if (op.requestBody && typeof op.requestBody === "object") {
        const contentMap = op.requestBody.content || {};
        for (const mediaTypeObj of Object.values(contentMap)) {
          const schema = mediaTypeObj?.schema;
          if (schema && Array.isArray(schema.required)) {
            for (const prop of schema.required) {
              const propStr = String(prop);
              if (!requestRequired.includes(propStr)) requestRequired.push(propStr);
            }
          }
        }
      }
      // Also check Swagger 2.0 body parameters
      for (const p of allParams) {
        if (p && p.in === "body" && p.schema && Array.isArray(p.schema.required)) {
          for (const prop of p.schema.required) {
            const propStr = String(prop);
            if (!requestRequired.includes(propStr)) requestRequired.push(propStr);
          }
        }
      }

      // security
      let security = globalSecurity;
      if (Array.isArray(op.security)) {
        security = op.security.length > 0;
      } else if (op.security && typeof op.security === "object") {
        security = Object.keys(op.security).length > 0;
      }

      const routeName = `${method} ${pathStr}`;
      // T-103: /users/{id} and /users/{userId} are the same route. Match on a normalized key
      // (every {param} segment becomes {}) while keeping the original path text in names/messages.
      const routeKeyName = `${method} ${String(pathStr).replace(/\{[^}]*\}/g, "{}")}`;
      const source = { file: filePath, line: routeLine };
      const routeId = getStableId("api.route", routeKeyName, source);

      entities.push({
        kind: "api.route",
        id: routeId,
        name: routeName,
        source,
        attrs: {
          method,
          path: pathStr,
          operationId,
          tags,
          requiredParams,
          requestRequired,
          security
        }
      });
    }
  }
}

// A UTF-16 file (SSMS / PowerShell 5.1) read as UTF-8, or a binary file, cannot be parsed. Detect it from the raw bytes
// (Buffer) or from the decoded string: a UTF-16 BOM decoded as UTF-8 starts with two replacement chars, and UTF-16 text
// has NUL bytes between characters. A UTF-8 BOM (EF BB BF) is fine and is stripped before this check.
function isUtf16OrBinaryContent(raw) {
  if (Buffer.isBuffer(raw)) {
    const head = raw.subarray(0, 4096);
    if (head.length >= 2 && ((head[0] === 0xFF && head[1] === 0xFE) || (head[0] === 0xFE && head[1] === 0xFF))) return true;
    return head.includes(0);
  }
  if (typeof raw !== "string") return false;
  const head = raw.replace(/^\uFEFF/, "").slice(0, 4096);
  if (head.startsWith("\uFFFD\uFFFD")) return true;
  return head.includes("\u0000");
}

export function extractFacts(files = [], opts = {}) {
  const entities = [];
  const relations = [];
  const sources = [];
  const errors = [];
  const parseErrors = [];
  const skipped = [];
  const contentFingerprints = new Map();
  const getStableId = createIdRegistry(errors);
  const graphqlSchemas = [];
  const graphqlFilesByDir = new Map();

  const fileList = Array.isArray(files) ? files : [];

  for (const f of fileList) {
    if (!f || typeof f !== "object") continue;
    const filePath = f.path || "unknown";
    if (f.skipped) {
      skipped.push({ path: filePath, reason: f.reason, fingerprint: f.fingerprint || null, helmChart: f.helmChart === true });
      errors.push({ file: filePath, message: f.reason, reason: f.reason, skipped: true });
      continue;
    }

    if (isUtf16OrBinaryContent(f.content)) {
      const reason = "UTF-16 or binary file: save it as UTF-8 to have it checked";
      skipped.push({ path: filePath, reason });
      errors.push({ file: filePath, message: reason, reason, skipped: true });
      continue;
    }

    const content = typeof f.content === "string" ? f.content.replace(/^\uFEFF/, "") : "";
    const startEntityCount = entities.length;
    if (content && content.includes("{{")) contentFingerprints.set(filePath, crypto.createHash("sha1").update(content).digest("hex"));

    let obj = null;
    if (typeof f.content === "object" && f.content !== null) {
      obj = f.content;
    }

    const filename = filePath.split(/[\/\\]/).pop();

    let isTf = false;
    if (/\.json$/i.test(filename)) {
      const head4k = typeof content === "string" ? content.slice(0, 4096) : "";
      if (head4k.includes('"format_version"') && head4k.includes('"terraform_version"')) {
        isTf = true;
      }
    }
    const maxAllowed = isTf ? Math.max(50 * 1024 * 1024, getMaxFileBytes()) : getMaxFileBytes();
    if (typeof content === "string" && Buffer.byteLength(content, "utf8") > maxAllowed) {
      const capMb = isTf ? Math.max(50, getMaxFileMb()) : getMaxFileMb();
      const reason = `File size exceeds ${capMb} MB limit (${(Buffer.byteLength(content, "utf8") / (1024 * 1024)).toFixed(1)} MB)`;
      skipped.push({ path: filePath, reason, fingerprint: `size:${Buffer.byteLength(content, "utf8")}` });
      errors.push({ file: filePath, message: reason, reason, skipped: true });
      continue;
    }

    const isPrisma = /\.prisma$/i.test(filename) || (typeof content === "string" && /model\s+[A-Za-z0-9_-]+\s*\{/i.test(content) && !/version\s*:/i.test(content));
    const isCompose = /^(?:docker-compose.*|compose.*)\.ya?ml$/i.test(filename) ||
      (typeof content === "string" && /\.ya?ml$/i.test(filename) && /^\s*services\s*:/m.test(content)) ||
      (obj && typeof obj.services === "object");
    const isOpenApiYaml = typeof content === "string" && /\.ya?ml$/i.test(filename) && !isCompose &&
      (/^(?:openapi.*|swagger.*)\.ya?ml$/i.test(filename) || /^\s*(?:openapi|swagger)\s*:/m.test(content));
    const isOpenApiJson = (/\.json$/i.test(filename) || filePath.includes("openapi") || filePath.includes("swagger")) &&
      ((typeof content === "string" && (/(?:openapi|swagger)/i.test(filename) || /"openapi"\s*:|"swagger"\s*:/i.test(content))) ||
       (obj && ("openapi" in obj || "swagger" in obj)));
    const isProto = isProtoFile(filePath) || (typeof content === "string" && /syntax\s*=\s*["']proto[23]["']/i.test(content));
    const isGraphQL = isGraphQLFile(filePath) || /\.graphqls$/i.test(filename) || (typeof content === "string" && /(?:type|schema|query|mutation)\s+[A-Za-z0-9_-]+\s*\{/i.test(content) && !isPrisma && !isCompose);
    const head4k = typeof content === "string" ? content.slice(0, 4096) : "";
    const isTerraform = (f.kind === "Terraform") || (
      /\.json$/i.test(filename) && !isOpenApiJson && (
        (obj && isTerraformPlanJson(filePath, obj)) ||
        (typeof content === "string" &&
          head4k.includes('"format_version"') && head4k.includes('"terraform_version"'))
      )
    );

    if (isPrisma) {
      try {
        parsePrismaFacts(filePath, content, getStableId, entities, relations, errors);
        sources.push({
          path: filePath,
          kind: "Database",
          entityCount: entities.length - startEntityCount
        });
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, line: 1, error: err.message, message: `Prisma parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isCompose) {
      try {
        const ok = parseComposeFacts(filePath, content, getStableId, entities, relations, errors, parseErrors);
        if (ok !== false) {
          sources.push({
            path: filePath,
            kind: "Services",
            entityCount: entities.length - startEntityCount
          });
        }
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, line: 1, error: err.message, message: `Docker Compose parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isOpenApiYaml || isOpenApiJson) {
      if (isOpenApiYaml && isHelmTemplate(filePath, content, f.fullPath, opts.rootDir || null, opts.addedCharts || null)) {
        const reason = "Helm template: render with `helm template` and scan the output";
        skipped.push({ path: filePath, reason, helmChart: hasChartAncestor(f.fullPath, opts.rootDir || null, opts.addedCharts || null) });
        errors.push({ file: filePath, message: reason, reason, skipped: true });
        continue;
      }
      try {
        const ok = parseOpenApiFacts(filePath, content, getStableId, entities, relations, errors, parseErrors);
        if (ok !== false) {
          sources.push({
            path: filePath,
            kind: "API",
            entityCount: entities.length - startEntityCount
          });
        }
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, line: 1, error: err.message, message: `OpenAPI parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isSqlMigrationCandidate(filePath, f.fullPath, filename)) {
      try {
        parseSqlFacts(filePath, content, getStableId, entities, relations, sources, errors);
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, line: 1, error: err.message, message: `SQL parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isK8sManifest(filePath, content, obj)) {
      try {
        const ok = parseK8sFacts(filePath, content, getStableId, entities, relations, errors, skipped, parseErrors, f.fullPath, opts.rootDir || null, opts.addedCharts || null);
        if (ok && ok.skipped) {
          continue;
        }
        if (ok !== false) {
          sources.push({
            path: filePath,
            kind: "Kubernetes",
            entityCount: entities.length - startEntityCount
          });
        }
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, line: 1, error: err.message, message: `Kubernetes parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isProto) {
      try {
        parseProtoFacts(filePath, content, getStableId, entities, relations, errors, parseErrors);
        sources.push({
          path: filePath,
          kind: "Protobuf",
          entityCount: entities.length - startEntityCount
        });
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, error: err.message, message: `Protobuf parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isTerraform) {
      try {
        const rawContent = typeof content === "string" && content ? content : (obj ? JSON.stringify(obj) : "");
        const res = parseTerraformPlanFacts(filePath, obj || content, getStableId, entities, relations, errors, parseErrors);
        if (res !== false) {
          const contentHash = crypto.createHash("sha256").update(rawContent).digest("hex");
          sources.push({
            path: filePath,
            kind: "Terraform",
            entityCount: entities.length - startEntityCount,
            content: contentHash,
            events: res?.events || []
          });
        }
      } catch (err) {
        const errEntry = { file: filePath, path: filePath, line: 1, error: err.message, message: `Terraform parse error: ${err.message}` };
        errors.push(errEntry);
        parseErrors.push(errEntry);
      }
    } else if (isGraphQL) {
      const normalizedPath = filePath.replace(/\\/g, "/");
      const dir = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : ".";
      if (!graphqlFilesByDir.has(dir)) {
        graphqlFilesByDir.set(dir, []);
      }
      graphqlFilesByDir.get(dir).push({ path: filePath, content });
    }
  }

  // Parse GraphQL files grouped by directory
  for (const [dir, gFiles] of graphqlFilesByDir.entries()) {
    const startEntityCount = entities.length;
    try {
      const gResult = parseGraphQLFacts(gFiles, dir, getStableId, entities, relations, errors, parseErrors);
      if (gResult) {
        graphqlSchemas.push(gResult);
        for (const gf of gFiles) {
          sources.push({
            path: gf.path,
            kind: "GraphQL",
            entityCount: entities.length - startEntityCount
          });
        }
      }
    } catch (err) {
      const firstPath = gFiles[0]?.path || dir;
      const errEntry = { file: firstPath, path: firstPath, error: err.message, message: `GraphQL schema build error in ${dir}: ${err.message}` };
      errors.push(errEntry);
      parseErrors.push(errEntry);
    }
  }

  const result = {
    entities,
    relations,
    sources,
    errors,
    parseErrors,
    // A skipped file's fingerprint lets `check` report it only when it is new or changed, not on every PR
    skipped: skipped.map((s) => s.fingerprint ? s : { ...s, fingerprint: contentFingerprints.get(s.path) || null }),
    _graphqlSchemas: graphqlSchemas
  };

  if (opts.truncated || files?.truncated) {
    result.truncated = true;
    if (opts.reason || files?.reason) {
      result.reason = opts.reason || files.reason;
    }
  }

  return result;
}
