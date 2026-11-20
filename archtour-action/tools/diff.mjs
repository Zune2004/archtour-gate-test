// Architecture Diff Engine for CI/CD & Pull Request Reviews
// Compares two diagram specs (or code schemas parsed to specs) and identifies:
// - Added / Removed / Modified nodes
// - Added / Removed / Modified edges
// Generates a visual diff diagram spec and markdown PR summary.

import fs from "node:fs";
import path from "node:path";
import { parsePrismaSchema, parseDockerCompose, parseOpenApi } from "./from-code.mjs";
import { parseDsl } from "./dsl.mjs";
import { parseMermaid } from "./mermaid.mjs";

function plural(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

export function mdText(value, max = 200, opts = {}) {
  let isCode = false;
  let maxLen = 200;

  if (typeof max === "boolean") {
    isCode = max;
    maxLen = 200;
  } else if (typeof max === "object" && max !== null) {
    isCode = Boolean(max.code);
    maxLen = typeof max.max === "number" ? max.max : 200;
  } else {
    maxLen = typeof max === "number" ? max : 200;
    if (typeof opts === "boolean") {
      isCode = opts;
    } else if (typeof opts === "object" && opts !== null) {
      isCode = Boolean(opts.code);
      if (typeof opts.max === "number") maxLen = opts.max;
    }
  }

  let str = value == null ? "" : String(value);
  str = str.replace(/[\r\n\t]+/g, " ");

  if (str.length > maxLen) {
    str = str.slice(0, maxLen) + "…";
  }

  if (isCode) {
    const matches = str.match(/`+/g);
    let maxRun = 0;
    if (matches) {
      for (const m of matches) {
        if (m.length > maxRun) maxRun = m.length;
      }
    }
    const fenceLen = Math.max(1, maxRun + 1);
    const fence = "`".repeat(fenceLen);
    const needsSpace = str.startsWith("`") || str.endsWith("`");
    return needsSpace ? `${fence} ${str} ${fence}` : `${fence}${str}${fence}`;
  }

  // Outside code spans:
  // Neutralise @ mentions and #123 issue refs
  str = str.replace(/@(?=\w)/g, "@\u200B");
  str = str.replace(/#(?=\d)/g, "#\u200B");

  // Never emit raw HTML from user text
  str = str.replace(/&/g, "&amp;");
  str = str.replace(/</g, "&lt;");
  str = str.replace(/>/g, "&gt;");

  // Escape markdown characters: \ ` * _ [ ] | # ! ~
  str = str.replace(/\\/g, "\\\\");
  str = str.replace(/`/g, "\\`");
  str = str.replace(/\*/g, "\\*");
  str = str.replace(/_/g, "\\_");
  str = str.replace(/\[/g, "\\[");
  str = str.replace(/\]/g, "\\]");
  str = str.replace(/\|/g, "\\|");
  str = str.replace(/#/g, "\\#");
  str = str.replace(/!/g, "\\!");
  str = str.replace(/~/g, "\\~");

  return str;
}

export function mdCode(value, max = 200) {
  return mdText(value, max, { code: true });
}

export function loadOrParseSpec(input, filename = "") {
  if (typeof input === "object" && input !== null) {
    return input;
  }

  let content = "";
  let file = filename;

  if (typeof input === "string") {
    if (fs.existsSync(input)) {
      content = fs.readFileSync(input, "utf8");
      file = input;
    } else {
      content = input;
    }
  }

  const name = path.basename(file).toLowerCase();

  if (file.endsWith(".prisma") || /model\s+[A-Za-z0-9_-]+\s*\{/i.test(content)) {
    const spec = parsePrismaSchema(content);
    if (!spec.title) spec.title = path.basename(file, path.extname(file));
    return spec;
  }

  if ((file.includes("compose") && (file.endsWith(".yml") || file.endsWith(".yaml"))) || /services\s*:\s*\r?\n\s+[A-Za-z0-9_-]+:/i.test(content)) {
    const spec = parseDockerCompose(content);
    if (!spec.title) spec.title = path.basename(file, path.extname(file));
    return spec;
  }

  if (name.includes("openapi") || name.includes("swagger") || /"openapi"\s*:/i.test(content) || /"swagger"\s*:/i.test(content)) {
    const spec = parseOpenApi(content);
    return spec;
  }

  if (file.endsWith(".diag") || file.endsWith(".dsl") || /^(title|direction|preset|nodes|edges):/m.test(content)) {
    const spec = parseDsl(content);
    if (!spec.title) spec.title = path.basename(file, path.extname(file));
    return spec;
  }

  if (file.endsWith(".mmd") || /^(graph|flowchart|stateDiagram)/m.test(content)) {
    const spec = parseMermaid(content);
    if (!spec.title) spec.title = path.basename(file, path.extname(file));
    return spec;
  }

  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse diagram spec from ${file || "input"}: ${err.message}`);
  }
}

function compareNodeFields(bNode, hNode) {
  const baseHasFields = Array.isArray(bNode?.fields);
  const headHasFields = Array.isArray(hNode?.fields);

  if (!baseHasFields && !headHasFields) {
    // Specs without fields (hand-written JSON): keep label/style comparison
    const isModified =
      bNode.label !== hNode.label ||
      bNode.shape !== hNode.shape ||
      bNode.detail !== hNode.detail ||
      bNode.color !== hNode.color;
    return { hasFields: false, isModified, fieldChanges: null };
  }

  const bFields = bNode?.fields || [];
  const hFields = hNode?.fields || [];

  const baseMap = new Map(bFields.map(f => [f.name, f]));
  const headMap = new Map(hFields.map(f => [f.name, f]));

  const added = [];
  const removed = [];
  const modified = [];

  for (const [name, hField] of headMap.entries()) {
    if (!baseMap.has(name)) {
      added.push(hField);
    } else {
      const bField = baseMap.get(name);
      const bAttrs = Array.isArray(bField.attrs) ? bField.attrs.slice().sort().join(",") : "";
      const hAttrs = Array.isArray(hField.attrs) ? hField.attrs.slice().sort().join(",") : "";
      const typeChanged = bField.type !== hField.type;
      const attrChanged = bAttrs !== hAttrs;

      if (typeChanged || attrChanged) {
        modified.push({ base: bField, head: hField });
      }
    }
  }

  for (const [name, bField] of baseMap.entries()) {
    if (!headMap.has(name)) {
      removed.push(bField);
    }
  }

  // Compose image / build comparison (if present on node directly and not already in fields)
  let composeChanged = false;
  const bImg = bNode.image;
  const hImg = hNode.image;
  if ((bImg || hImg) && bImg !== hImg && !baseMap.has("image") && !headMap.has("image")) {
    composeChanged = true;
    modified.push({
      base: { name: "image", type: bImg || "none" },
      head: { name: "image", type: hImg || "none" }
    });
  }

  const bBuild = bNode.build;
  const hBuild = hNode.build;
  if ((bBuild || hBuild) && bBuild !== hBuild && !baseMap.has("build") && !headMap.has("build")) {
    composeChanged = true;
    modified.push({
      base: { name: "build", type: bBuild || "none" },
      head: { name: "build", type: hBuild || "none" }
    });
  }

  const isModified = added.length > 0 || removed.length > 0 || modified.length > 0 || composeChanged;

  return {
    hasFields: true,
    isModified,
    fieldChanges: isModified ? { added, removed, modified } : null
  };
}

export function isComposeNode(node) {
  if (!node) return false;
  if (typeof node.tooltip === "string" && (node.tooltip.startsWith("Service:") || node.tooltip.startsWith("Image:"))) {
    return true;
  }
  if (typeof node.detail === "string" && node.detail.startsWith("### Service:")) {
    return true;
  }
  if (node.image || node.build) {
    return true;
  }
  if (Array.isArray(node.fields)) {
    return node.fields.some(
      (f) =>
        f &&
        (f.name === "image" ||
          f.name === "build" ||
          f.type === "port" ||
          f.type === "volume" ||
          f.type === "env")
    );
  }
  return false;
}

export function computeSpecDiff(baseSpec, headSpec) {
  const baseNodes = Array.isArray(baseSpec?.nodes) ? baseSpec.nodes : [];
  const headNodes = Array.isArray(headSpec?.nodes) ? headSpec.nodes : [];
  const baseEdges = Array.isArray(baseSpec?.edges) ? baseSpec.edges : [];
  const headEdges = Array.isArray(headSpec?.edges) ? headSpec.edges : [];

  function buildNodeMap(nodes) {
    const map = new Map();
    const seen = new Set();
    for (const n of nodes) {
      if (!n) continue;
      let key = n.originalName || n.name || String(n.id);
      if (seen.has(key)) {
        let c = 2;
        while (seen.has(`${key}#${c}`)) c++;
        console.warn(`Warning: duplicate node key "${key}", renamed to "${key}#${c}"`);
        key = `${key}#${c}`;
      }
      seen.add(key);
      map.set(key, n);
    }
    return map;
  }

  const baseNodeMap = buildNodeMap(baseNodes);
  const headNodeMap = buildNodeMap(headNodes);

  const isCompose =
    baseSpec?.title === "Container Infrastructure" ||
    headSpec?.title === "Container Infrastructure" ||
    baseSpec?.preset === "blueprint" ||
    headSpec?.preset === "blueprint" ||
    baseNodes.some(isComposeNode) ||
    headNodes.some(isComposeNode);

  const addedNodes = [];
  const removedNodes = [];
  const modifiedNodes = [];
  const unchangedNodes = [];

  for (const [id, hNode] of headNodeMap.entries()) {
    if (!baseNodeMap.has(id)) {
      addedNodes.push(hNode);
    } else {
      const bNode = baseNodeMap.get(id);
      const diffResult = compareNodeFields(bNode, hNode);

      if (diffResult.isModified) {
        modifiedNodes.push({
          base: bNode,
          head: hNode,
          fieldChanges: diffResult.fieldChanges,
          hasFields: diffResult.hasFields,
          isCompose: isCompose || isComposeNode(bNode) || isComposeNode(hNode)
        });
      } else {
        unchangedNodes.push(hNode);
      }
    }
  }

  for (const [id, bNode] of baseNodeMap.entries()) {
    if (!headNodeMap.has(id)) {
      removedNodes.push(bNode);
    }
  }

  // Edge comparison helper: canonical key
  const edgeKey = (e) => `${e.from}->${e.to}`;

  const baseEdgeMap = new Map(baseEdges.map((e) => [edgeKey(e), e]));
  const headEdgeMap = new Map(headEdges.map((e) => [edgeKey(e), e]));

  const addedEdges = [];
  const removedEdges = [];
  const modifiedEdges = [];
  const unchangedEdges = [];

  for (const [key, hEdge] of headEdgeMap.entries()) {
    if (!baseEdgeMap.has(key)) {
      addedEdges.push(hEdge);
    } else {
      const bEdge = baseEdgeMap.get(key);
      const isModified = bEdge.label !== hEdge.label || bEdge.style !== hEdge.style;
      if (isModified) {
        modifiedEdges.push({ base: bEdge, head: hEdge });
      } else {
        unchangedEdges.push(hEdge);
      }
    }
  }

  for (const [key, bEdge] of baseEdgeMap.entries()) {
    if (!headEdgeMap.has(key)) {
      removedEdges.push(bEdge);
    }
  }

  const hasChanges =
    addedNodes.length > 0 ||
    removedNodes.length > 0 ||
    modifiedNodes.length > 0 ||
    addedEdges.length > 0 ||
    removedEdges.length > 0 ||
    modifiedEdges.length > 0;

  return {
    hasChanges,
    isCompose,
    addedNodes,
    removedNodes,
    modifiedNodes,
    unchangedNodes,
    addedEdges,
    removedEdges,
    modifiedEdges,
    unchangedEdges
  };
}

export function formatNonZeroSummary(addedCount, removedCount, modifiedCount, unit = "fields") {
  const parts = [];
  if (addedCount > 0) parts.push(`+${addedCount}`);
  if (removedCount > 0) parts.push(`-${removedCount}`);
  if (modifiedCount > 0) parts.push(`~${modifiedCount}`);
  const total = addedCount + removedCount + modifiedCount;
  let word = unit;
  if (unit === "change" || unit === "changes") {
    word = plural(total, "change");
  } else if (unit === "field" || unit === "fields") {
    word = plural(total, "field");
  } else if (unit === "service" || unit === "services") {
    word = plural(total, "service");
  } else if (unit === "model" || unit === "models") {
    word = plural(total, "model");
  }
  if (parts.length === 0) return `0 ${word}`;
  return `${parts.join(" / ")} ${word}`;
}

export function fieldText(name, type) {
  if (!type || (typeof type === "string" && !type.trim())) {
    return name;
  }
  return `${name}: ${type}`;
}

export function createVisualDiffSpec(baseSpec, headSpec, diff) {
  const nodes = [];
  const edges = [];

  // 1. Added Nodes: Green with "+" badge
  for (const n of diff.addedNodes) {
    nodes.push({
      ...n,
      color: "green",
      label: `+ ${n.label || n.id}`,
      tooltip: `[Added] ${n.tooltip || n.label || n.id}`,
      detail: `### 🟢 Added Component\n\n${n.detail || n.tooltip || n.label || n.id}`
    });
  }

  // 2. Removed Nodes: Red dashed with "-" badge
  for (const n of diff.removedNodes) {
    nodes.push({
      ...n,
      color: "red",
      label: `- ${n.label || n.id}`,
      tooltip: `[Removed] ${n.tooltip || n.label || n.id}`,
      detail: `### 🔴 Removed Component\n\n${n.detail || n.tooltip || n.label || n.id}`
    });
  }

  // 3. Modified Nodes: Orange with "~" badge
  for (const mod of diff.modifiedNodes) {
    const { base, head, fieldChanges, hasFields } = mod;

    if (hasFields && fieldChanges) {
      const compName = (head.label || head.id).split(/\r?\n/)[0].replace(/^~ /, "").trim();
      const isComposeNodeItem = mod.isCompose || isComposeNode(head) || isComposeNode(base);
      const summaryCount = formatNonZeroSummary(
        fieldChanges.added.length,
        fieldChanges.removed.length,
        fieldChanges.modified.length,
        isComposeNodeItem ? "changes" : "fields"
      );

      const changeLines = [];
      for (const f of fieldChanges.added) {
        changeLines.push(`+ ${fieldText(f.name, f.type)}`);
      }
      for (const f of fieldChanges.removed) {
        changeLines.push(`- ${fieldText(f.name, f.type)}`);
      }
      for (const { base: bf, head: hf } of fieldChanges.modified) {
        if (bf.type !== hf.type) {
          const bType = (!bf.type || (typeof bf.type === "string" && !bf.type.trim())) ? "(none)" : bf.type;
          const hType = (!hf.type || (typeof hf.type === "string" && !hf.type.trim())) ? "(none)" : hf.type;
          changeLines.push(`~ ${fieldText(hf.name, `${bType} -> ${hType}`)}`);
        } else {
          const bAttrStr = Array.isArray(bf.attrs) ? bf.attrs.join(", ") : "";
          const hAttrStr = Array.isArray(hf.attrs) ? hf.attrs.join(", ") : "";
          changeLines.push(`~ ${fieldText(hf.name, hf.type)} (${bAttrStr || "none"} -> ${hAttrStr || "none"})`);
        }
      }

      const maxChangeLines = 6;
      const labelLines = [`~ ${compName}`];
      const displayedChanges = changeLines.slice(0, maxChangeLines);
      for (const c of displayedChanges) {
        labelLines.push(c);
      }
      if (changeLines.length > maxChangeLines) {
        labelLines.push(`+${changeLines.length - maxChangeLines} more`);
      }

      nodes.push({
        ...head,
        color: "orange",
        label: labelLines.join("\n"),
        tooltip: summaryCount,
        detail: `### 🟠 Modified Component: ${compName}\n\n**Field Changes:**\n${changeLines.map((c) => `- \`${c}\``).join("\n")}\n\n${head.detail || ""}`
      });
    } else {
      nodes.push({
        ...head,
        color: "orange",
        label: `~ ${head.label || head.id}`,
        tooltip: `[Modified] ${head.tooltip || head.label || head.id}`,
        detail: `### 🟠 Modified Component\n\n**Previous label:** ${base.label || base.id}\n\n**Current label:** ${head.label || head.id}\n\n${head.detail || ""}`
      });
    }
  }

  // 4. Unchanged Nodes: Subtle gray
  for (const n of diff.unchangedNodes) {
    nodes.push({
      ...n,
      color: "gray"
    });
  }

  // 5. Added Edges: Green
  for (const e of diff.addedEdges) {
    edges.push({
      ...e,
      color: "green",
      label: e.label ? `+ ${e.label}` : "+"
    });
  }

  // 6. Removed Edges: Red dashed
  for (const e of diff.removedEdges) {
    edges.push({
      ...e,
      color: "red",
      style: "dashed",
      label: e.label ? `- ${e.label}` : "-"
    });
  }

  // 7. Modified Edges: Orange
  for (const { head } of diff.modifiedEdges) {
    edges.push({
      ...head,
      color: "orange",
      label: head.label ? `~ ${head.label}` : "~"
    });
  }

  // 8. Unchanged Edges: Gray
  for (const e of diff.unchangedEdges) {
    edges.push({
      ...e,
      color: "gray"
    });
  }

  const baseTitle = headSpec?.title || baseSpec?.title || "Architecture Diff";
  const subtitle = `${diff.addedNodes.length} added, ${diff.removedNodes.length} removed, ${diff.modifiedNodes.length} modified`;

  return {
    title: `Diff: ${baseTitle}`,
    subtitle,
    direction: headSpec?.direction || baseSpec?.direction || "LR",
    preset: "clean",
    nodes,
    edges,
    steps: [
      {
        title: "Architecture Changes",
        text: `Summary: ${subtitle}.`,
        nodes: [...diff.addedNodes, ...diff.removedNodes, ...diff.modifiedNodes.map((m) => m.head)].map((n) => n.id)
      }
    ]
  };
}

function collapseNodeLabel(node) {
  if (!node) return "";
  const raw = node.label || node.tooltip || node.id || "";
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length <= 1) return mdText(lines[0] || node.id);
  if (Array.isArray(node.fields) && node.fields.length > 0) {
    const isCompose = isComposeNode(node);
    const unit = isCompose ? plural(node.fields.length, "change") : plural(node.fields.length, "field");
    return `${mdText(lines[0])} (${node.fields.length} ${unit})`;
  }
  return mdText(lines.join(" "));
}

function collapseToOneLine(str) {
  if (!str) return "";
  return String(str).replace(/\r?\n+/g, " ").trim();
}

export function formatMarkdownDiff(diff, opts = {}) {
  const title = opts.title || "Architecture Changes";

  if (!diff.hasChanges) {
    return `### 📊 ${title}\n\n*No architectural changes detected.*`;
  }

  const lines = [];
  lines.push(`### 📊 ${title}\n`);
  lines.push("| Element | Added (+) | Removed (-) | Modified (~) |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| **Nodes / Components** | ${diff.addedNodes.length} | ${diff.removedNodes.length} | ${diff.modifiedNodes.length} |`
  );
  lines.push(
    `| **Connections / Relations** | ${diff.addedEdges.length} | ${diff.removedEdges.length} | ${diff.modifiedEdges.length} |`
  );
  lines.push("");

  lines.push("<details>");
  lines.push("<summary><b>Click to inspect component changes</b></summary>\n");

  if (diff.addedNodes.length > 0) {
    lines.push("#### 🟢 Added Components");
    for (const n of diff.addedNodes) {
      lines.push(`- **${mdCode(n.id)}**: ${collapseNodeLabel(n)}`);
    }
    lines.push("");
  }

  if (diff.removedNodes.length > 0) {
    lines.push("#### 🔴 Removed Components");
    for (const n of diff.removedNodes) {
      lines.push(`- **${mdCode(n.id)}**: ${collapseNodeLabel(n)}`);
    }
    lines.push("");
  }

  if (diff.modifiedNodes.length > 0) {
    lines.push("#### 🟠 Modified Components");
    for (const mod of diff.modifiedNodes) {
      const { base, head, fieldChanges, hasFields } = mod;
      if (hasFields && fieldChanges) {
        const compName = (head.label || head.id).split(/\r?\n/)[0].replace(/^~ /, "").trim();
        const isComposeNodeItem =
          opts.isCompose ||
          opts.kind === "Services" ||
          diff.isCompose ||
          /(?:docker-compose|compose)/i.test(opts.title || "") ||
          mod.isCompose ||
          isComposeNode(head) ||
          isComposeNode(base);
        const summaryCount = formatNonZeroSummary(
          fieldChanges.added.length,
          fieldChanges.removed.length,
          fieldChanges.modified.length,
          isComposeNodeItem ? "changes" : "fields"
        );
        const summary = `~ ${mdText(compName)}  ${summaryCount}`;
        lines.push(`- **${mdCode(head.id)}**: ${summary}`);
        for (const f of fieldChanges.added) {
          lines.push(`  - ${mdCode(`+ ${fieldText(f.name, f.type)}`)}`);
        }
        for (const f of fieldChanges.removed) {
          lines.push(`  - ${mdCode(`- ${fieldText(f.name, f.type)}`)}`);
        }
        for (const { base: bf, head: hf } of fieldChanges.modified) {
          if (bf.type !== hf.type) {
            const bType = (!bf.type || (typeof bf.type === "string" && !bf.type.trim())) ? "(none)" : bf.type;
            const hType = (!hf.type || (typeof hf.type === "string" && !hf.type.trim())) ? "(none)" : hf.type;
            lines.push(`  - ${mdCode(`~ ${fieldText(hf.name, `${bType} -> ${hType}`)}`)}`);
          } else {
            const bAttrStr = Array.isArray(bf.attrs) ? bf.attrs.join(", ") : "";
            const hAttrStr = Array.isArray(hf.attrs) ? hf.attrs.join(", ") : "";
            lines.push(`  - ${mdCode(`~ ${fieldText(hf.name, hf.type)} (${bAttrStr || "none"} -> ${hAttrStr || "none"})`)}`);
          }
        }
      } else {
        const bLabel = collapseToOneLine(base.label || base.id);
        const hLabel = collapseToOneLine(head.label || head.id);
        lines.push(`- **${mdCode(head.id)}**: ${mdCode(bLabel)} ➔ ${mdCode(hLabel)}`);
      }
    }
    lines.push("");
  }

  if (diff.addedEdges.length > 0) {
    lines.push("#### 🟢 Added Connections");
    for (const e of diff.addedEdges) {
      const eLabel = collapseToOneLine(e.label);
      lines.push(`- ${mdCode(e.from)} ➔ ${mdCode(e.to)}${eLabel ? ` (*${mdText(eLabel)}*)` : ""}`);
    }
    lines.push("");
  }

  if (diff.removedEdges.length > 0) {
    lines.push("#### 🔴 Removed Connections");
    for (const e of diff.removedEdges) {
      const eLabel = collapseToOneLine(e.label);
      lines.push(`- ${mdCode(e.from)} ➔ ${mdCode(e.to)}${eLabel ? ` (*${mdText(eLabel)}*)` : ""}`);
    }
    lines.push("");
  }

  lines.push("</details>");
  if (opts.footer !== false) {
    lines.push("");
    lines.push("*Generated by [Archtour](https://github.com/Zune2004/archtour).*");
  }

  return lines.join("\n");
}
