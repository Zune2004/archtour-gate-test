import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parsePrismaSchema, parseDockerCompose, parseOpenApi } from "./from-code.mjs";
import { splitLargeSpec } from "./split.mjs";
import { isSqlMigrationCandidate } from "./facts-sql.mjs";
import { isTerraformPlanJson } from "./facts-terraform.mjs";
import { getMaxFileBytes, getMaxFileMb } from "./settings.mjs";

function plural(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

const HEAVY_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "vendor",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "bower_components",
  "Pods"
]);

const DEFAULT_TEST_DIR_NAMES = new Set([
  "fixtures",
  "__fixtures__",
  "testdata",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "examples",
  "example",
  "samples",
  "sample"
]);

function shouldSkipDir(name) {
  return name.startsWith(".") || HEAVY_DIR_NAMES.has(name) || HEAVY_DIR_NAMES.has(name.toLowerCase());
}

export { shouldSkipDir, DEFAULT_TEST_DIR_NAMES };

// True when a Chart.yaml/Chart.yml exists in this file's folder or any ancestor (up to rootDir).
export function hasChartAncestor(fullPath, rootDir = null, ignoreCharts = null) {
  if (!fullPath) return false;
  let curr = path.dirname(path.resolve(fullPath));
  const stopDir = rootDir ? path.resolve(rootDir) : null;
  while (curr) {
    let found = false;
    try {
      const entries = fs.readdirSync(curr, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name === "Chart.yaml" || entry.name === "Chart.yml")) {
          const resolved = path.resolve(curr, entry.name);
          if (!ignoreCharts || !ignoreCharts.has(resolved)) {
            found = true;
            break;
          }
        }
      }
    } catch {}
    if (found) return true;
    if (stopDir && path.resolve(curr) === stopDir) break;
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return false;
}

function stripYamlComment(line) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    } else if (ch === "#" && !inSingleQuote && !inDoubleQuote && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

export function isHelmTemplate(filePath, content, fullPath = null, rootDir = null, ignoreCharts = null) {
  // No template syntax = plain YAML, wherever it lives: adding a Chart.yaml must not hide an ordinary manifest from the check.
  if (typeof content !== "string" || !content.includes("{{")) return false;
  // Go-template actions outside comment lines: {{ .Values.x }}, {{- include ... }}, {{ if }}, {{ end }}, {{ $var }}.
  // Templates often still parse as (meaningless) YAML, so parsing alone cannot tell them apart. A `{{ wiki }}` comment or a
  // "{{token}}" placeholder in a description is not a template.
  const code = content.split(/\r?\n/).map(stripYamlComment).filter((line) => !/^\s*$/.test(line)).join("\n");
  if (/\{\{-?\s*(?:\.|\$|include\b|template\b|if\b|else\b|end\b|range\b|with\b|define\b|block\b|toYaml\b|tpl\b|printf\b|required\b|default\b|lookup\b)/.test(code)) {
    return true;
  }
  const norm = (fullPath || filePath || "").replace(/\\/g, "/");
  const parts = norm.split("/");
  const templatesIdx = parts.lastIndexOf("templates");
  if (templatesIdx !== -1 && templatesIdx < parts.length - 1) {
    if (hasChartAncestor(fullPath || filePath, rootDir, ignoreCharts)) return true;
  }

  if (typeof content === "string" && content.includes("{{")) {
    // parseAllDocuments, not parse: YAML.parse throws on any multi-document file (`---`), which made every such manifest "Helm"
    try {
      const docs = YAML.parseAllDocuments(content, { logLevel: "error", merge: true });
      for (const d of docs) {
        if (d && d.errors && d.errors.length > 0) return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

export function isCandidateFile(filename, relPath = "", fullPath = "") {
  return Boolean(
    /^(?:docker-compose.*|compose.*)\.ya?ml$/i.test(filename) ||
    /\.ya?ml$/i.test(filename) ||
    /\.prisma$/i.test(filename) ||
    /\.json$/i.test(filename) ||
    isSqlMigrationCandidate(relPath, fullPath, filename) ||
    /\.(?:graphql|gql|graphqls)$/i.test(filename) ||
    /\.proto$/i.test(filename)
  );
}

export function isCandidateSource(filePath, opts = {}) {
  if (!filePath || typeof filePath !== "string") return false;
  const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = norm.split("/");
  const filename = segments.pop();
  if (!filename || filename.startsWith(".")) return false;

  const userIgnoreList = opts.ignore
    ? (Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore])
    : [];
  const normalizedUserIgnores = userIgnoreList
    .map(s => String(s).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);

  let cur = "";
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    if (shouldSkipDir(seg)) return false;
    if (!opts.includeTests && (DEFAULT_TEST_DIR_NAMES.has(seg) || DEFAULT_TEST_DIR_NAMES.has(seg.toLowerCase()))) {
      const hasUserIgnoreUnderDir = normalizedUserIgnores.some(p => p.startsWith(cur + "/"));
      if (!hasUserIgnoreUnderDir) return false;
    }
    const isUserIgnored = normalizedUserIgnores.some(p => {
      if (!p.includes("/")) return seg === p || cur === p || cur.startsWith(p + "/");
      return cur === p || cur.startsWith(p + "/");
    });
    if (isUserIgnored) return false;
  }

  const isUserIgnored = normalizedUserIgnores.some(p => {
    if (!p.includes("/")) return filename === p || norm === p;
    return norm === p || norm.startsWith(p + "/");
  });
  if (isUserIgnored) return false;

  return isCandidateFile(filename, norm, norm);
}

export function scanRepo(dir = ".", opts = {}) {
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(rootDir)) {
    throw new Error(`No Prisma schema, Docker Compose file or OpenAPI JSON found under ${dir}`);
  }

  const maxWalkEntries = opts.maxFiles != null ? Number(opts.maxFiles) : (opts.maxWalkEntries != null ? Number(opts.maxWalkEntries) : 200000);
  const maxDepth = opts.maxDepth != null ? Number(opts.maxDepth) : 12;
  const maxCandidates = 20000;
  const maxCandidateSize = getMaxFileBytes();

  const userIgnoreList = opts.ignore
    ? (Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore])
    : [];
  const normalizedUserIgnores = userIgnoreList
    .map(s => String(s).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);

  const found = [];
  const skipped = [];
  const ignored = [];
  const parseErrors = [];
  let visitedEntriesCount = 0;
  let fileLimitReached = false;
  let candidateCount = 0;
  let truncated = false;
  let unexaminedCount = 0;
  let truncationReason = null;
  let defaultIgnoredDirsCount = 0;

  function walk(currentDir, depth) {
    if (depth > maxDepth || fileLimitReached) return;

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (fileLimitReached) break;

      visitedEntriesCount++;
      if (visitedEntriesCount > maxWalkEntries) {
        fileLimitReached = true;
        truncated = true;
        truncationReason = `Hit ${maxWalkEntries.toLocaleString()} file limit; scan truncated`;
        const relCurrent = path.relative(rootDir, currentDir).replace(/\\/g, "/") || ".";
        skipped.push({
          path: relCurrent,
          reason: truncationReason
        });
        break;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;

        const relDir = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        const isUserIgnored = normalizedUserIgnores.some(pattern => {
          if (!pattern.includes("/")) {
            return entry.name === pattern || relDir === pattern || relDir.startsWith(pattern + "/");
          }
          return relDir === pattern || relDir.startsWith(pattern + "/");
        });

        if (isUserIgnored) {
          skipped.push({
            path: relDir,
            reason: "ignored"
          });
          ignored.push(relDir);
          continue;
        }

        const isDefaultTestDir = !opts.includeTests && (
          DEFAULT_TEST_DIR_NAMES.has(entry.name) ||
          DEFAULT_TEST_DIR_NAMES.has(entry.name.toLowerCase())
        );

        if (isDefaultTestDir) {
          const hasUserIgnoreUnderDir = normalizedUserIgnores.some(p => p.startsWith(relDir + "/"));
          if (!hasUserIgnoreUnderDir) {
            defaultIgnoredDirsCount++;
            skipped.push({
              path: relDir,
              reason: "default-ignored"
            });
            ignored.push(relDir);
            continue;
          }
        }

        if (depth < maxDepth) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const filename = entry.name;
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        const isCandidate = isCandidateFile(filename, relPath, fullPath);

        if (!isCandidate) continue;

        candidateCount++;
        if (candidateCount > maxCandidates) {
          truncated = true;
          unexaminedCount++;
          continue;
        }

        // Skip candidate files exceeding 5 MB
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
          skipped.push({ path: relPath, reason: err.message });
          continue;
        }

        if (stat.size > maxCandidateSize) {
          skipped.push({
            path: relPath,
            reason: `File size exceeds ${getMaxFileMb()} MB limit (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`
          });
          continue;
        }

        // 1. Docker Compose
        if (/^(?:docker-compose.*|compose.*)\.ya?ml$/i.test(filename)) {
          let content;
          try {
            content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
          } catch (err) {
            skipped.push({ path: relPath, reason: err.message, error: err.message });
            parseErrors.push({ path: relPath, error: err.message });
            continue;
          }
          try {
            const spec = parseDockerCompose(content);
            spec.title = `Services · ${relPath}`;
            const serviceCount = spec.nodes ? spec.nodes.length : 0;
            found.push({
              path: relPath,
              kind: "Services",
              spec,
              count: serviceCount,
              summary: `${serviceCount} container ${plural(serviceCount, "service")}`,
              sentence: `${serviceCount} container ${plural(serviceCount, "service")} defined in ${relPath}.`
            });
          } catch (err) {
            skipped.push({ path: relPath, reason: err.message, error: err.message });
            parseErrors.push({ path: relPath, error: err.message });
          }
          continue;
        }

        // 2. OpenAPI / Swagger YAML (or any .yml/.yaml whose top level has openapi/swagger)
        if (/\.ya?ml$/i.test(filename)) {
          let content;
          try {
            content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
          } catch (err) {
            skipped.push({ path: relPath, reason: err.message, error: err.message });
            parseErrors.push({ path: relPath, error: err.message });
            continue;
          }

          if (isHelmTemplate(relPath, content, fullPath, rootDir)) {
            skipped.push({
              path: relPath,
              reason: "Helm template: render with `helm template` and scan the output",
              helmChart: hasChartAncestor(fullPath, rootDir)
            });
            continue;
          }

          const isOpenApiName = /^(?:openapi.*|swagger.*)\.ya?ml$/i.test(filename);
          let doc;
          try {
            doc = YAML.parse(content, { merge: true, logLevel: "error" });
          } catch (err) {
            if (isOpenApiName || /^\s*(?:openapi|swagger)\s*:/m.test(content)) {
              skipped.push({ path: relPath, reason: err.message, error: err.message });
              parseErrors.push({ path: relPath, error: err.message });
            }
            continue;
          }

          if (doc && typeof doc === "object" && !Array.isArray(doc) && ("openapi" in doc || "swagger" in doc)) {
            try {
              const spec = parseOpenApi(doc);
              spec.title = `API · ${relPath}`;
              const routeCount = (spec.nodes || []).reduce(
                (acc, n) => (n.id === "client" || n.id === "gateway" ? acc : acc + (n.fields ? n.fields.length : 0)),
                0
              );
              const tagCount = (spec.nodes || []).filter(n => n.id !== "client" && n.id !== "gateway").length;
              found.push({
                path: relPath,
                kind: "API",
                spec,
                count: routeCount,
                summary: `${routeCount} API ${plural(routeCount, "route")}`,
                sentence: `${routeCount} API ${plural(routeCount, "route")} across ${tagCount} ${plural(tagCount, "controller")} defined in ${relPath}.`
              });
            } catch (err) {
              skipped.push({ path: relPath, reason: err.message, error: err.message });
              parseErrors.push({ path: relPath, error: err.message });
            }
          } else if (isOpenApiName) {
            const msg = "No OpenAPI specification found in file";
            skipped.push({ path: relPath, reason: msg, error: msg });
            parseErrors.push({ path: relPath, error: msg });
          }
          continue;
        }

        // 3. Prisma Schema
        if (/\.prisma$/i.test(filename)) {
          let content;
          try {
            content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
          } catch (err) {
            skipped.push({ path: relPath, reason: err.message, error: err.message });
            parseErrors.push({ path: relPath, error: err.message });
            continue;
          }
          try {
            const spec = parsePrismaSchema(content);
            spec.title = `Database · ${relPath}`;
            const modelCount = spec.nodes ? spec.nodes.length : 0;
            found.push({
              path: relPath,
              kind: "Database",
              spec,
              count: modelCount,
              summary: `${modelCount} database ${plural(modelCount, "model")}`,
              sentence: `${modelCount} database ${plural(modelCount, "model")} defined in ${relPath}.`
            });
          } catch (err) {
            skipped.push({ path: relPath, reason: err.message, error: err.message });
            parseErrors.push({ path: relPath, error: err.message });
          }
          continue;
        }

        // 4. OpenAPI / Swagger JSON
        if (/\.json$/i.test(filename)) {
          let content;
          try {
            content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
          } catch {
            continue;
          }
          let doc;
          try {
            doc = JSON.parse(content);
          } catch (err) {
            if (/^(?:openapi.*|swagger.*)\.json$/i.test(filename) || /"openapi"\s*:|"swagger"\s*:/i.test(content)) {
              skipped.push({ path: relPath, reason: err.message, error: err.message });
              parseErrors.push({ path: relPath, error: err.message });
            }
            continue;
          }
          if (doc && typeof doc === "object" && !Array.isArray(doc) && ("openapi" in doc || "swagger" in doc)) {
            try {
              const spec = parseOpenApi(doc);
              spec.title = `API · ${relPath}`;
              const routeCount = (spec.nodes || []).reduce(
                (acc, n) => (n.id === "client" || n.id === "gateway" ? acc : acc + (n.fields ? n.fields.length : 0)),
                0
              );
              const tagCount = (spec.nodes || []).filter(n => n.id !== "client" && n.id !== "gateway").length;
              found.push({
                path: relPath,
                kind: "API",
                spec,
                count: routeCount,
                summary: `${routeCount} API ${plural(routeCount, "route")}`,
                sentence: `${routeCount} API ${plural(routeCount, "route")} across ${tagCount} ${plural(tagCount, "controller")} defined in ${relPath}.`
              });
            } catch (err) {
              skipped.push({ path: relPath, reason: err.message, error: err.message });
              parseErrors.push({ path: relPath, error: err.message });
            }
          }
          continue;
        }
      }
    }
  }

  walk(rootDir, 0);

  if (found.length === 0 && !truncated) {
    const err = new Error(`No Prisma schema, Docker Compose file or OpenAPI JSON found under ${dir}`);
    err.parseErrors = parseErrors;
    err.skipped = skipped;
    throw err;
  }

  // Sort found items in order Database, Services, API; then by path
  const KIND_ORDER = { Database: 1, Services: 2, API: 3 };
  found.sort((a, b) => (KIND_ORDER[a.kind] || 99) - (KIND_ORDER[b.kind] || 99) || a.path.localeCompare(b.path));

  const seenIds = new Set();
  const overviewNodes = [];
  const steps = [];

  for (const item of found) {
    let baseId = item.kind.toLowerCase();
    let id = baseId;
    let counter = 2;
    while (seenIds.has(id)) {
      id = `${baseId}-${counter++}`;
    }
    seenIds.add(id);

    let color = "blue";
    let detailTitle = "Database Models";
    if (item.kind === "Services") {
      color = "violet";
      detailTitle = "Container Services";
    } else if (item.kind === "API") {
      color = "orange";
      detailTitle = "API Endpoints";
    }

    const detail = `### ${detailTitle} (${item.path})\n\nFound **${item.summary}**.\n\nClick the drill badge to explore the detailed diagram.`;

    let sizeUnit = "items";
    if (item.kind === "Database") {
      sizeUnit = plural(item.count, "model");
    } else if (item.kind === "Services") {
      sizeUnit = plural(item.count, "container");
    } else if (item.kind === "API") {
      sizeUnit = plural(item.count, "route");
    }
    const sizeStr = `${item.count} ${sizeUnit}`;

    item.spec.title = `${item.kind} · ${item.path}`;

    const drillSpec = !opts.noSplit
      ? splitLargeSpec(item.spec, { maxNodes: opts.maxNodes != null ? opts.maxNodes : 15 })
      : item.spec;
    item.spec = drillSpec;

    overviewNodes.push({
      id,
      label: `${item.kind} · ${sizeStr}\n${item.path}`,
      shape: "rectangle",
      color,
      tooltip: `${item.kind}: ${item.path}`,
      detail,
      drill: drillSpec
    });

    steps.push({
      title: `${item.kind} (${item.path})`,
      text: item.sentence,
      nodes: [id],
      dive: [id]
    });
  }

  const folderName = path.basename(rootDir) || "Repository";
  const spec = {
    title: `${folderName} architecture`,
    direction: "LR",
    preset: "clean",
    nodes: overviewNodes,
    edges: [],
    steps
  };

  if (unexaminedCount > 0) {
    truncationReason = `${unexaminedCount} candidate files were not checked; raise --max-files`;
    skipped.push({
      path: ".",
      reason: truncationReason
    });
  }

  return {
    spec,
    found,
    skipped,
    parseErrors,
    ignored,
    truncated,
    unexaminedCount,
    reason: truncationReason,
    truncationReason,
    defaultIgnoredDirs: defaultIgnoredDirsCount,
    defaultIgnoredCount: defaultIgnoredDirsCount
  };
}

export function discoverFiles(dir = ".", opts = {}) {
  const rootDir = path.resolve(dir);
  if (!fs.existsSync(rootDir)) {
    throw new Error(`Target does not exist: ${dir}`);
  }

  const rootStat = fs.statSync(rootDir);
  if (rootStat.isFile()) {
    const filename = path.basename(rootDir);
    let content = "";
    try {
      content = fs.readFileSync(rootDir, "utf8").replace(/^\uFEFF/, "");
    } catch (err) {
      return {
        files: [],
        skipped: [{ path: filename, reason: err.message }],
        parseErrors: [{ path: filename, error: err.message }],
        ignored: [],
        truncated: false,
        unexaminedCount: 0,
        reason: null,
        defaultIgnoredDirs: 0
      };
    }
    return {
      files: [{ path: filename, fullPath: rootDir, content }],
      skipped: [],
      parseErrors: [],
      ignored: [],
      truncated: false,
      unexaminedCount: 0,
      reason: null,
      defaultIgnoredDirs: 0
    };
  }

  const maxWalkEntries = opts.maxWalkEntries != null ? Number(opts.maxWalkEntries) : 200000;
  const maxDepth = opts.maxDepth != null ? Number(opts.maxDepth) : 12;
  const maxCandidates = opts.maxFiles != null ? Number(opts.maxFiles) : (opts.maxCandidates != null ? Number(opts.maxCandidates) : 20000);
  const maxCandidateSize = getMaxFileBytes();

  const userIgnoreList = opts.ignore
    ? (Array.isArray(opts.ignore) ? opts.ignore : [opts.ignore])
    : [];
  const normalizedUserIgnores = userIgnoreList
    .map(s => String(s).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);

  const files = [];
  const skipped = [];
  const ignored = [];
  const parseErrors = [];
  let visitedEntriesCount = 0;
  let fileLimitReached = false;
  let candidateCount = 0;
  let truncated = false;
  let unexaminedCount = 0;
  let truncationReason = null;
  let defaultIgnoredDirsCount = 0;

  function walk(currentDir, depth) {
    if (depth > maxDepth || fileLimitReached) return;

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (fileLimitReached) break;

      visitedEntriesCount++;
      if (visitedEntriesCount > maxWalkEntries) {
        fileLimitReached = true;
        truncated = true;
        truncationReason = `Hit ${maxWalkEntries.toLocaleString()} file limit; scan truncated`;
        const relCurrent = path.relative(rootDir, currentDir).replace(/\\/g, "/") || ".";
        skipped.push({
          path: relCurrent,
          reason: truncationReason
        });
        break;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;

        const relDir = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        const isUserIgnored = normalizedUserIgnores.some(pattern => {
          if (!pattern.includes("/")) {
            return entry.name === pattern || relDir === pattern || relDir.startsWith(pattern + "/");
          }
          return relDir === pattern || relDir.startsWith(pattern + "/");
        });

        if (isUserIgnored) {
          skipped.push({
            path: relDir,
            reason: "ignored"
          });
          ignored.push(relDir);
          continue;
        }

        const isDefaultTestDir = !opts.includeTests && (
          DEFAULT_TEST_DIR_NAMES.has(entry.name) ||
          DEFAULT_TEST_DIR_NAMES.has(entry.name.toLowerCase())
        );

        if (isDefaultTestDir) {
          const hasUserIgnoreUnderDir = normalizedUserIgnores.some(p => p.startsWith(relDir + "/"));
          if (!hasUserIgnoreUnderDir) {
            defaultIgnoredDirsCount++;
            skipped.push({
              path: relDir,
              reason: "default-ignored"
            });
            ignored.push(relDir);
            continue;
          }
        }

        if (depth < maxDepth) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const filename = entry.name;
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        const isCandidate = isCandidateFile(filename, relPath, fullPath);

        if (!isCandidate) continue;

        candidateCount++;
        if (candidateCount > maxCandidates) {
          truncated = true;
          unexaminedCount++;
          continue;
        }

        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch (err) {
          skipped.push({ path: relPath, reason: err.message });
          continue;
        }

        let isTfCandidate = false;
        if (/\.json$/i.test(filename)) {
          try {
            const fd = fs.openSync(fullPath, "r");
            const buf = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            fs.closeSync(fd);
            const head4k = buf.toString("utf8", 0, bytesRead);
            if (head4k.includes('"format_version"') && head4k.includes('"terraform_version"')) {
              isTfCandidate = true;
            }
          } catch {}
        }

        const maxAllowed = isTfCandidate ? Math.max(50 * 1024 * 1024, getMaxFileBytes()) : maxCandidateSize;
        if (stat.size > maxAllowed) {
          const capMb = isTfCandidate ? Math.max(50, getMaxFileMb()) : getMaxFileMb();
          const reason = `File size exceeds ${capMb} MB limit (${(stat.size / (1024 * 1024)).toFixed(1)} MB)`;
          skipped.push({
            path: relPath,
            reason
          });
          files.push({
            path: relPath,
            fullPath,
            content: "",
            skipped: true,
            reason,
            fingerprint: `size:${stat.size}`
          });
          continue;
        }

        let content;
        try {
          content = fs.readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
        } catch (err) {
          skipped.push({ path: relPath, reason: err.message, error: err.message });
          parseErrors.push({ path: relPath, error: err.message });
          continue;
        }

        // Docker compose
        if (/^(?:docker-compose.*|compose.*)\.ya?ml$/i.test(filename) || (/\.ya?ml$/i.test(filename) && /^\s*services\s*:/m.test(content))) {
          files.push({ path: relPath, fullPath, content, kind: "Services" });
          continue;
        }

        // Prisma
        if (/\.prisma$/i.test(filename) || (/model\s+[A-Za-z0-9_-]+\s*\{/i.test(content) && !/version\s*:/i.test(content))) {
          files.push({ path: relPath, fullPath, content, kind: "Database" });
          continue;
        }

        // OpenAPI YAML & Kubernetes YAML
        if (/\.ya?ml$/i.test(filename)) {
          if (isHelmTemplate(relPath, content, fullPath, rootDir)) {
            const reason = "Helm template: render with `helm template` and scan the output";
            const helmChart = hasChartAncestor(fullPath, rootDir);
            skipped.push({
              path: relPath,
              reason,
              helmChart
            });
            files.push({
              path: relPath,
              fullPath,
              content: "",
              skipped: true,
              reason,
              helmChart,
              fingerprint: crypto.createHash("sha1").update(content).digest("hex")
            });
            continue;
          }

          const isOpenApiName = /^(?:openapi.*|swagger.*)\.ya?ml$/i.test(filename);
          let doc;
          try {
            doc = YAML.parse(content, { merge: true, logLevel: "error" });
          } catch {
            if (/^\s*apiVersion\s*:/m.test(content) && /^\s*kind\s*:/m.test(content)) {
              files.push({ path: relPath, fullPath, content, kind: "Kubernetes" });
            }
            continue;
          }
          if (doc && typeof doc === "object" && !Array.isArray(doc) && ("openapi" in doc || "swagger" in doc)) {
            files.push({ path: relPath, fullPath, content, kind: "API" });
            continue;
          }
          if (/^\s*apiVersion\s*:/m.test(content) && /^\s*kind\s*:/m.test(content)) {
            files.push({ path: relPath, fullPath, content, kind: "Kubernetes" });
            continue;
          }
          continue;
        }

        // OpenAPI JSON & Terraform Plan JSON
        if (/\.json$/i.test(filename)) {
          const head4k = content.slice(0, 4096);
          const hasTfTokens = head4k.includes('"format_version"') && head4k.includes('"terraform_version"');

          let doc;
          try {
            doc = JSON.parse(content);
          } catch (err) {
            if (/^(?:openapi.*|swagger.*)\.json$/i.test(filename) || /"openapi"\s*:|"swagger"\s*:/i.test(content)) {
              skipped.push({ path: relPath, reason: err.message, error: err.message });
              parseErrors.push({ path: relPath, error: err.message });
            } else if (hasTfTokens) {
              files.push({ path: relPath, fullPath, content, kind: "Terraform" });
            }
            continue;
          }
          if (doc && typeof doc === "object" && !Array.isArray(doc)) {
            if ("openapi" in doc || "swagger" in doc) {
              files.push({ path: relPath, fullPath, content, kind: "API" });
            } else if (hasTfTokens && isTerraformPlanJson(relPath, doc)) {
              files.push({ path: relPath, fullPath, content, kind: "Terraform" });
            }
          }
          continue;
        }

        // 5. SQL Migrations
        if (isSqlMigrationCandidate(relPath, fullPath, filename)) {
          files.push({ path: relPath, fullPath, content, kind: "Database" });
          continue;
        }

        // GraphQL
        if (/\.(?:graphql|gql|graphqls)$/i.test(filename)) {
          files.push({ path: relPath, fullPath, content, kind: "GraphQL" });
          continue;
        }

        // Protobuf
        if (/\.proto$/i.test(filename)) {
          files.push({ path: relPath, fullPath, content, kind: "Protobuf" });
          continue;
        }
      }
    }
  }

  walk(rootDir, 0);

  if (unexaminedCount > 0) {
    truncationReason = `${unexaminedCount} candidate files were not checked; raise --max-files`;
    skipped.push({
      path: ".",
      reason: truncationReason
    });
  }

  // Natural sort order (e.g. V2 before V10)
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

  return {
    files,
    skipped,
    parseErrors,
    ignored,
    truncated,
    unexaminedCount,
    reason: truncationReason,
    truncationReason,
    defaultIgnoredDirs: defaultIgnoredDirsCount
  };
}

