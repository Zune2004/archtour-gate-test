// Mermaid to Diagram Spec converter
// Converts Mermaid flowcharts (flowchart LR/TD) and state diagrams (stateDiagram-v2)
// into the diagram spec JSON format used by Archtour.

const SHAPES = [
  { open: "[(", close: ")]", shape: "ellipse" },
  { open: "([", close: "])", shape: "ellipse" },
  { open: "((", close: "))", shape: "ellipse" },
  { open: "{{", close: "}}", shape: "diamond" },
  { open: "[/", close: "/]", shape: "rectangle" },
  { open: "[\\", close: "\\]", shape: "rectangle" },
  { open: "[", close: "]", shape: "rectangle" },
  { open: "(", close: ")", shape: "rectangle" },
  { open: "{", close: "}", shape: "diamond" },
];

function cleanLabel(raw) {
  if (!raw) return "";
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return s.replace(/<br\s*\/?>/gi, "\n").trim();
}

function parseNodeToken(token) {
  const t = token.trim();
  if (!t) return null;

  for (const { open, close, shape } of SHAPES) {
    const oIdx = t.indexOf(open);
    if (oIdx > 0 && t.endsWith(close)) {
      const id = t.slice(0, oIdx).trim();
      const rawLabel = t.slice(oIdx + open.length, t.length - close.length);
      return { id, label: cleanLabel(rawLabel) || id, shape };
    }
  }

  // Plain identifier without shape brackets
  const cleanId = t.replace(/^["']|["']$/g, "").trim();
  return { id: cleanId, label: cleanId, shape: "rectangle" };
}

// Regex to split a line by arrows while capturing the arrow token
const ARROW_PATTERN = /(-->\|[^|]+\||-\.->\|[^|]+\||==>\|[^|]+\||---\|[^|]+\||<-->\|[^|]+\||--\s+[^-\n>]+\s+-->|-\.\s+[^.\n>]+\s+\.->|==\s+[^=\n>]+\s+==>|-->|-\.->|==>|---|--|<-->|-\.-)/g;

function parseEdgeToken(arrowStr) {
  let style = "solid";
  let arrow = "end";
  let label = "";

  const s = arrowStr.trim();
  if (s.includes("-.-") || s.includes("-.->") || s.includes("-.")) {
    style = "dashed";
  }

  if (s.startsWith("<-->") || s.startsWith("<--")) {
    arrow = "both";
  } else if (s.endsWith("---") || s === "--" || s === "-.-") {
    arrow = "none";
  } else {
    arrow = "end";
  }

  // Check for pipe label: -->|label|
  const pipeMatch = s.match(/\|([^|]+)\|/);
  if (pipeMatch) {
    label = cleanLabel(pipeMatch[1]);
  } else {
    // Check for inline labels: -- label --> or -. label .-> or == label ==>
    const inlineMatch = s.match(/(?:--|-\.|\=\=)\s+([^-\.=\n>]+?)\s+(?:-->|\.->|==>)/);
    if (inlineMatch) {
      label = cleanLabel(inlineMatch[1]);
    }
  }

  return { style, arrow, label };
}

export function parseMermaid(src) {
  if (!src || typeof src !== "string") {
    throw new Error("Mermaid source must be a non-empty string");
  }

  const rawLines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines = [];

  // Filter out comments and empty lines
  for (let ln of rawLines) {
    const commentIdx = ln.indexOf("%%");
    if (commentIdx !== -1) ln = ln.slice(0, commentIdx);
    ln = ln.trim();
    if (ln) lines.push(ln);
  }

  if (!lines.length) {
    throw new Error("Empty Mermaid diagram source");
  }

  const firstLine = lines[0];
  const headerMatch = firstLine.match(/^([a-zA-Z0-9_-]+)(?:\s+(.*))?$/);
  if (!headerMatch) {
    throw new Error(`Unable to determine Mermaid diagram type from "${firstLine}"`);
  }

  const type = headerMatch[1].toLowerCase();
  const headerRest = (headerMatch[2] || "").trim().toUpperCase();

  if (type === "statediagram" || type === "statediagram-v2") {
    return parseStateDiagram(lines);
  }

  if (type === "flowchart" || type === "graph") {
    return parseFlowchart(lines, headerRest || "TB");
  }

  throw new Error(
    `Unsupported Mermaid diagram type "${headerMatch[1]}". Interactive conversion currently supports flowcharts (flowchart LR/TD) and state diagrams (stateDiagram-v2).\nTo render this diagram as a static image, run: node tools/diagram.mjs mermaid <file.mmd>`
  );
}

function parseFlowchart(lines, defaultDir) {
  let direction = defaultDir === "LR" || defaultDir === "RL" || defaultDir === "BT" ? defaultDir : "TB";
  const nodesMap = new Map();
  const edges = [];
  const groups = [];
  const groupStack = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (/^direction\s+(LR|RL|TB|TD|BT)$/i.test(line)) {
      const d = line.match(/^direction\s+(LR|RL|TB|TD|BT)$/i)[1].toUpperCase();
      direction = d === "TD" ? "TB" : d;
      continue;
    }

    // Subgraph start
    const subMatch = line.match(/^subgraph\s+([A-Za-z0-9_-]+)(?:\s*\[(.*?)\])?/i) || line.match(/^subgraph\s+"(.*)"/i);
    if (subMatch) {
      let gId, gLabel;
      if (line.match(/^subgraph\s+"(.*)"/i)) {
        gLabel = line.match(/^subgraph\s+"(.*)"/i)[1];
        gId = `grp_${groups.length + 1}`;
      } else {
        gId = subMatch[1];
        gLabel = cleanLabel(subMatch[2]) || gId;
      }
      const grp = { id: gId, label: gLabel, nodes: [], color: "gray" };
      groups.push(grp);
      groupStack.push(grp);
      continue;
    }

    // Subgraph end
    if (/^end$/i.test(line)) {
      if (groupStack.length > 0) {
        groupStack.pop();
      }
      continue;
    }

    // Node styling directives
    const styleMatch = line.match(/^style\s+([A-Za-z0-9_-]+)\s+(.+)$/i);
    if (styleMatch) {
      const id = styleMatch[1];
      const props = styleMatch[2];
      const fillMatch = props.match(/fill:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/);
      if (fillMatch && nodesMap.has(id)) {
        nodesMap.get(id).color = fillMatch[1];
      }
      continue;
    }

    // Edge / node line
    // Find all arrow matches and positions
    const arrowMatches = [];
    let m;
    ARROW_PATTERN.lastIndex = 0;
    while ((m = ARROW_PATTERN.exec(line)) !== null) {
      arrowMatches.push({
        arrow: m[0],
        start: m.index,
        end: m.index + m[0].length
      });
    }

    if (arrowMatches.length === 0) {
      // Standalone node definition: e.g. user([User])
      const nodeObj = parseNodeToken(line);
      if (nodeObj) {
        if (!nodesMap.has(nodeObj.id)) {
          nodesMap.set(nodeObj.id, nodeObj);
        } else if (nodeObj.label !== nodeObj.id) {
          nodesMap.get(nodeObj.id).label = nodeObj.label;
          nodesMap.get(nodeObj.id).shape = nodeObj.shape;
        }
        if (groupStack.length > 0) {
          const currentGrp = groupStack[groupStack.length - 1];
          if (!currentGrp.nodes.includes(nodeObj.id)) currentGrp.nodes.push(nodeObj.id);
        }
      }
      continue;
    }

    // Line with one or more arrows: e.g. A --> B --> C
    const segmentTokens = [];
    let lastPos = 0;
    for (let j = 0; j < arrowMatches.length; j++) {
      const am = arrowMatches[j];
      const nodePart = line.slice(lastPos, am.start).trim();
      segmentTokens.push(nodePart);
      lastPos = am.end;
    }
    segmentTokens.push(line.slice(lastPos).trim());

    // Expand chained edges
    for (let j = 0; j < arrowMatches.length; j++) {
      const leftPart = segmentTokens[j];
      const rightPart = segmentTokens[j + 1];
      const edgeMeta = parseEdgeToken(arrowMatches[j].arrow);

      // Part can be multi-node with '&': e.g. A & B
      const leftNodes = leftPart.split(/\s+&\s+/).map(parseNodeToken).filter(Boolean);
      const rightNodes = rightPart.split(/\s+&\s+/).map(parseNodeToken).filter(Boolean);

      for (const ln of leftNodes) {
        if (!nodesMap.has(ln.id)) nodesMap.set(ln.id, ln);
        else if (ln.label !== ln.id) {
          nodesMap.get(ln.id).label = ln.label;
          nodesMap.get(ln.id).shape = ln.shape;
        }
        if (groupStack.length > 0) {
          const currentGrp = groupStack[groupStack.length - 1];
          if (!currentGrp.nodes.includes(ln.id)) currentGrp.nodes.push(ln.id);
        }
      }

      for (const rn of rightNodes) {
        if (!nodesMap.has(rn.id)) nodesMap.set(rn.id, rn);
        else if (rn.label !== rn.id) {
          nodesMap.get(rn.id).label = rn.label;
          nodesMap.get(rn.id).shape = rn.shape;
        }
        if (groupStack.length > 0) {
          const currentGrp = groupStack[groupStack.length - 1];
          if (!currentGrp.nodes.includes(rn.id)) currentGrp.nodes.push(rn.id);
        }
      }

      for (const ln of leftNodes) {
        for (const rn of rightNodes) {
          const edge = { from: ln.id, to: rn.id };
          if (edgeMeta.label) edge.label = edgeMeta.label;
          if (edgeMeta.style !== "solid") edge.style = edgeMeta.style;
          if (edgeMeta.arrow !== "end") edge.arrow = edgeMeta.arrow;
          edges.push(edge);
        }
      }
    }
  }

  // Filter empty groups
  const validGroups = groups.filter((g) => g.nodes.length > 0);

  return {
    direction,
    nodes: Array.from(nodesMap.values()),
    edges,
    ...(validGroups.length ? { groups: validGroups } : {})
  };
}

function parseStateDiagram(lines) {
  let direction = "TB";
  const nodesMap = new Map();
  const edges = [];
  let startCount = 0;
  let endCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    if (/^direction\s+(LR|RL|TB|TD|BT)$/i.test(line)) {
      const d = line.match(/^direction\s+(LR|RL|TB|TD|BT)$/i)[1].toUpperCase();
      direction = d === "TD" ? "TB" : d;
      continue;
    }

    // State description: state "Desc" as S1
    const stateMatch = line.match(/^state\s+"(.*?)"\s+as\s+([A-Za-z0-9_-]+)/i);
    if (stateMatch) {
      nodesMap.set(stateMatch[2], {
        id: stateMatch[2],
        label: cleanLabel(stateMatch[1]),
        shape: "rectangle"
      });
      continue;
    }

    // Transition line: S1 --> S2 : Label
    const transMatch = line.match(/^(\[\*\]|[A-Za-z0-9_-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_-]+)(?:\s*:\s*(.*))?$/);
    if (transMatch) {
      let from = transMatch[1];
      let to = transMatch[2];
      const label = cleanLabel(transMatch[3] || "");

      if (from === "[*]") {
        const startId = "_start" + (++startCount > 1 ? startCount : "");
        nodesMap.set(startId, { id: startId, label: "Start", shape: "ellipse", color: "blue" });
        from = startId;
      } else if (!nodesMap.has(from)) {
        nodesMap.set(from, { id: from, label: from, shape: "rectangle" });
      }

      if (to === "[*]") {
        const endId = "_end" + (++endCount > 1 ? endCount : "");
        nodesMap.set(endId, { id: endId, label: "End", shape: "ellipse", color: "gray" });
        to = endId;
      } else if (!nodesMap.has(to)) {
        nodesMap.set(to, { id: to, label: to, shape: "rectangle" });
      }

      const edge = { from, to };
      if (label) edge.label = label;
      edges.push(edge);
    }
  }

  return {
    direction,
    nodes: Array.from(nodesMap.values()),
    edges
  };
}
