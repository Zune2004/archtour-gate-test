// Plain-Text Diagram DSL parser
// Converts shorthand diagram text into the diagram spec JSON format.

const SHAPES = new Set(["rectangle", "ellipse", "diamond", "text"]);
const COLORS = new Set(["black", "gray", "blue", "green", "red", "yellow", "orange", "violet", "teal", "pink"]);
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

function cleanStr(s) {
  if (!s) return "";
  let res = s.trim();
  if ((res.startsWith('"') && res.endsWith('"')) || (res.startsWith("'") && res.endsWith("'"))) {
    res = res.slice(1, -1);
  }
  return res.replace(/\\n/g, "\n").trim();
}

function parseProps(propStr) {
  const props = {};
  if (!propStr) return props;
  const inside = propStr.trim().replace(/^\{|\}$/g, "").trim();
  if (!inside) return props;

  // Split by comma outside of quotes
  const parts = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      if (cur.trim()) parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());

  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx !== -1) {
      const k = part.slice(0, colonIdx).trim();
      const v = cleanStr(part.slice(colonIdx + 1));
      props[k] = v;
    } else {
      // Shorthand shape or color
      const val = part.trim().toLowerCase();
      if (SHAPES.has(val)) props.shape = val;
      else if (COLORS.has(val) || HEX_RE.test(val)) props.color = val;
    }
  }
  return props;
}

function matchEdgeLine(ln) {
  const arrowMatch = ln.match(/\s*(<-->|<->|-\.->|\.\.>|-->|->|--|\.\.)\s*/);
  if (!arrowMatch) return null;

  const from = ln.slice(0, arrowMatch.index).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(from)) return null;

  const arrowOp = arrowMatch[1];
  const rest = ln.slice(arrowMatch.index + arrowMatch[0].length).trim();
  if (!rest) return null;

  const toMatch = rest.match(/^([A-Za-z0-9_-]+)(?:\s*(?::|\||\[)\s*(.*?))?$/);
  if (!toMatch) return null;

  const to = toMatch[1];
  let label = toMatch[2] ? toMatch[2].trim() : "";
  if (label.endsWith("]") || label.endsWith("|")) {
    label = label.slice(0, -1).trim();
  }

  return { from, arrowOp, to, label: cleanStr(label) };
}

export function parseDsl(src) {
  if (!src || typeof src !== "string") {
    throw new Error("DSL source must be a non-empty string");
  }

  const rawLines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const spec = {
    direction: "TB",
    nodes: [],
    edges: [],
    groups: [],
    steps: []
  };

  const nodesMap = new Map();
  let currentGroup = null;
  let currentStep = null;

  for (let rawLine of rawLines) {
    if (rawLine.length > 20000) {
      throw new Error(`DSL line exceeds maximum length of 20000 characters (${rawLine.length})`);
    }
    let ln = rawLine.trim();
    // Strip comments
    if (ln.startsWith("#") || ln.startsWith("//")) continue;
    const commentIdx = ln.indexOf(" //");
    if (commentIdx !== -1) ln = ln.slice(0, commentIdx).trim();
    if (!ln) continue;

    // Header properties: title, subtitle, direction, preset
    const headerMatch = ln.match(/^(title|subtitle|direction|preset|style):\s*(.+)$/i);
    if (headerMatch) {
      const key = headerMatch[1].toLowerCase();
      const val = cleanStr(headerMatch[2]);
      if (key === "direction") {
        const d = val.toUpperCase();
        spec.direction = d === "TD" ? "TB" : d;
      } else {
        spec[key] = val;
      }
      continue;
    }

    // End of multiline group or step
    if (/^end$/i.test(ln)) {
      currentGroup = null;
      continue;
    }

    // Step definition: step "Title" : Description
    const stepMatch = ln.match(/^step\s+(?:"([^"]+)"|(\S+))(?:\s*:\s*(.*))?$/i);
    if (stepMatch) {
      const title = stepMatch[1] || stepMatch[2];
      const text = stepMatch[3] ? cleanStr(stepMatch[3]) : "";
      currentStep = { title, text, nodes: [], edges: [] };
      spec.steps.push(currentStep);
      continue;
    }

    // Step properties (nodes / edges under a step)
    if (currentStep && /^nodes:\s*(.+)$/i.test(ln)) {
      const nodeIds = ln.match(/^nodes:\s*(.+)$/i)[1].split(",").map(s => s.trim()).filter(Boolean);
      currentStep.nodes.push(...nodeIds);
      continue;
    }

    // Group definition:
    // 1) Single-line: group cloud "Cloud Services" [api, ok, db] {color: gray}
    const singleGrpMatch = ln.match(/^group\s+([A-Za-z0-9_-]+)(?:\s+(?:"([^"]+)"|(\S+)))?\s*\[(.*?)\](?:\s*(\{.*?\}))?$/i);
    if (singleGrpMatch) {
      const gId = singleGrpMatch[1];
      const gLabel = singleGrpMatch[2] || singleGrpMatch[3] || gId;
      const gNodes = singleGrpMatch[4].split(",").map(s => s.trim()).filter(Boolean);
      const gProps = parseProps(singleGrpMatch[5] || "");
      spec.groups.push({
        id: gId,
        label: gLabel,
        nodes: gNodes,
        color: gProps.color || "gray",
        ...gProps
      });
      continue;
    }

    // 2) Multiline: group cloud "Cloud Services":
    const multiGrpMatch = ln.match(/^group\s+([A-Za-z0-9_-]+)(?:\s+(?:"([^"]+)"|(\S+)))?(?:\s*(\{.*?\}))?:$/i);
    if (multiGrpMatch) {
      const gId = multiGrpMatch[1];
      const gLabel = multiGrpMatch[2] || multiGrpMatch[3] || gId;
      const gProps = parseProps(multiGrpMatch[4] || "");
      currentGroup = {
        id: gId,
        label: gLabel,
        nodes: [],
        color: gProps.color || "gray",
        ...gProps
      };
      spec.groups.push(currentGroup);
      continue;
    }

    // Edge pattern: from (--> | -> | -.-> | ..> | <-> | <--> | -- | ..) to (: label | [label] | |label|)
    const edge = matchEdgeLine(ln);
    if (edge) {
      const { from, arrowOp, to, label } = edge;

      // Ensure nodes exist
      if (!nodesMap.has(from)) {
        nodesMap.set(from, { id: from, label: from, shape: "rectangle" });
      }
      if (!nodesMap.has(to)) {
        nodesMap.set(to, { id: to, label: to, shape: "rectangle" });
      }

      let style = "solid";
      let arrow = "end";
      if (arrowOp.includes("..") || arrowOp.includes("-.-")) style = "dashed";
      if (arrowOp.startsWith("<")) arrow = "both";
      else if (arrowOp === "--" || arrowOp === "..") arrow = "none";

      const edgeObj = { from, to };
      if (label) edgeObj.label = label;
      if (style !== "solid") edgeObj.style = style;
      if (arrow !== "end") edgeObj.arrow = arrow;
      spec.edges.push(edgeObj);

      if (currentGroup) {
        if (!currentGroup.nodes.includes(from)) currentGroup.nodes.push(from);
        if (!currentGroup.nodes.includes(to)) currentGroup.nodes.push(to);
      }
      continue;
    }

    // Node definition:
    // e.g. web "Web App" {shape: ellipse, color: blue, tooltip: "..."}
    // or [ok] Paid? {diamond, orange}
    // or plain: web {blue}
    const nodeMatch = ln.match(/^(?:\[([A-Za-z0-9_-]+)\]|([A-Za-z0-9_-]+))(?:\s+(?:"([^"]+)"|([^{]+?)))?(?:\s*(\{.*?\}))?$/);
    if (nodeMatch) {
      const id = nodeMatch[1] || nodeMatch[2];
      const rawLabel = nodeMatch[3] || nodeMatch[4];
      const label = rawLabel ? cleanStr(rawLabel) : id;
      const props = parseProps(nodeMatch[5] || "");

      const nodeObj = {
        id,
        label,
        shape: props.shape || "rectangle",
        ...props
      };

      nodesMap.set(id, nodeObj);
      if (currentGroup && !currentGroup.nodes.includes(id)) {
        currentGroup.nodes.push(id);
      }
      continue;
    }
  }

  spec.nodes = Array.from(nodesMap.values());
  if (!spec.steps.length) delete spec.steps;
  if (!spec.groups.length) delete spec.groups;
  return spec;
}
