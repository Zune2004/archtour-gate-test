// Graph-based diagram splitter for large schemas (>15 models)
// Splits large from-code architecture diagrams into drillable groups:
// - Identifies hubs (Core)
// - Clusters remaining graph into connected components (seed clusters)
// - Merges small clusters (<5 models) by shared words in model names
// - Packs leftovers into bins of <= maxNodes (ordered by hub relation, then id)
// - Splits any large clusters (>maxNodes) via deterministic BFS
// - Assigns descriptive group names ("<Word> models", "<Hub>-related", "<lead> group", "Core")
// - Core sub-diagram: hubs + ONE stub per other group (↗ <name> (<k> models))
// - Other sub-diagrams: at most 8 external model stubs, then one ↗ +N more stub
// - Overview spec: one node per group with cross-group relation counts

function plural(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function toGroupId(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractWords(node) {
  let raw = node.id || "";
  const labelFirstLine = (node.label || "").split("\n")[0].trim();
  // If raw is all lowercase alphanumeric without underscores/hyphens, but label has camelCase or uppercase, use label
  if (/^[a-z0-9]+$/.test(raw) && /[A-Z]/.test(labelFirstLine)) {
    raw = labelFirstLine;
  }

  // Split CamelCase: "LoginAttempt" -> "Login Attempt", "OAuthToken" -> "OAuth Token"
  let s = raw.replace(/([a-z])([A-Z])/g, "$1 $2")
             .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  // Drop digits and replace non-letters with spaces
  s = s.replace(/[\d_\-\s]+/g, " ");

  const tokens = s.split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && /^[a-z]+$/.test(w));

  return new Set(tokens);
}

function getClusterId(cluster) {
  const ids = cluster.models.map(m => m.id).sort();
  return ids[0];
}

function computeBinSizes(total, maxPerBin) {
  if (total === 0) return [];
  const numBins = Math.ceil(total / maxPerBin);
  if (numBins <= 1) return [total];

  // Start greedy
  const sizes = [];
  let remaining = total;
  for (let i = 0; i < numBins; i++) {
    const s = Math.min(maxPerBin, remaining);
    sizes.push(s);
    remaining -= s;
  }

  // If the last bin has < 3 and total >= 3, transfer from previous bins
  if (sizes[sizes.length - 1] < 3 && total >= 3) {
    let deficit = 3 - sizes[sizes.length - 1];
    for (let i = sizes.length - 2; i >= 0 && deficit > 0; i--) {
      const canSpare = sizes[i] - 3;
      const transfer = Math.min(canSpare, deficit);
      sizes[i] -= transfer;
      sizes[sizes.length - 1] += transfer;
      deficit -= transfer;
    }
  }

  return sizes;
}

function clusterGroupsLevel(groups, originalEdges, limit, spec) {
  const nodeToGroup = new Map();
  for (const g of groups) {
    for (const n of g.nodes) {
      nodeToGroup.set(n.id, g);
    }
  }

  const adj = new Map();
  for (const g of groups) {
    adj.set(g.id, new Set());
  }

  const pairMap = new Map();
  for (const e of (originalEdges || [])) {
    const gFrom = nodeToGroup.get(e.from);
    const gTo = nodeToGroup.get(e.to);
    if (!gFrom || !gTo || gFrom.id === gTo.id) continue;

    adj.get(gFrom.id).add(gTo.id);
    adj.get(gTo.id).add(gFrom.id);

    const [gA, gB] = gFrom.id < gTo.id ? [gFrom, gTo] : [gTo, gFrom];
    const key = `${gA.id}:::${gB.id}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, { gA, gB, total: 0, aToB: 0, bToA: 0 });
    }
    const entry = pairMap.get(key);
    entry.total++;
    if (gFrom.id === gA.id) entry.aToB++;
    else entry.bToA++;
  }

  const degrees = new Map();
  for (const g of groups) {
    degrees.set(g.id, adj.get(g.id).size);
  }

  const degList = groups.map(g => degrees.get(g.id)).sort((a, b) => a - b);
  const mid = Math.floor(degList.length / 2);
  const medianDegree = degList.length % 2 === 0
    ? (degList[mid - 1] + degList[mid]) / 2
    : degList[mid];

  const hubThreshold = Math.max(8, 3 * medianDegree);
  const candidateHubs = groups.filter(g => degrees.get(g.id) >= hubThreshold);
  candidateHubs.sort((a, b) => (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id));

  const coreGroups = candidateHubs.slice(0, limit);
  const coreGroupIds = new Set(coreGroups.map(g => g.id));

  const nonCoreGroups = groups.filter(g => !coreGroupIds.has(g.id));
  const nonCoreGroupMap = new Map(nonCoreGroups.map(g => [g.id, g]));

  const nonHubAdj = new Map();
  for (const g of nonCoreGroups) {
    nonHubAdj.set(g.id, new Set());
  }
  for (const g of nonCoreGroups) {
    for (const nbr of adj.get(g.id)) {
      if (!coreGroupIds.has(nbr)) {
        nonHubAdj.get(g.id).add(nbr);
      }
    }
  }

  const sortedNonCore = [...nonCoreGroups].sort((a, b) => a.id.localeCompare(b.id));
  const visited = new Set();
  const seedClusters = [];

  for (const startGroup of sortedNonCore) {
    if (visited.has(startGroup.id)) continue;
    const comp = [];
    const queue = [startGroup.id];
    visited.add(startGroup.id);

    while (queue.length > 0) {
      const curr = queue.shift();
      comp.push(nonCoreGroupMap.get(curr));
      const nbrs = [...nonHubAdj.get(curr)].sort((a, b) => a.localeCompare(b));
      for (const nbr of nbrs) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    comp.sort((a, b) => a.id.localeCompare(b.id));
    seedClusters.push({ groups: comp, mergedByWord: false });
  }

  const groupWords = new Map();
  for (const g of groups) {
    const rawWords = extractWords({ id: g.id, label: g.name });
    const filtered = new Set([...rawWords].filter(w => w !== "group" && w !== "models" && w !== "area"));
    groupWords.set(g.id, filtered);
  }

  let clusters = seedClusters.map(c => ({
    groups: [...c.groups],
    mergedByWord: false
  }));

  function clusterHasWord(cl, word) {
    return cl.groups.some(g => groupWords.get(g.id).has(word));
  }

  while (true) {
    const smallClusters = clusters.filter(c => c.groups.length < 5);
    if (smallClusters.length === 0) break;

    const candidateWords = new Set();
    for (const c of smallClusters) {
      for (const g of c.groups) {
        for (const w of groupWords.get(g.id)) {
          candidateWords.add(w);
        }
      }
    }

    if (candidateWords.size === 0) break;

    const wordStats = [];
    for (const w of candidateWords) {
      const matching = clusters.filter(c => clusterHasWord(c, w));
      if (matching.length < 2) continue;

      const sortedMatching = [...matching].sort((a, b) =>
        a.groups[0].id.localeCompare(b.groups[0].id)
      );

      let canMerge = false;
      let cur = 0;
      for (const cl of sortedMatching) {
        if (cur > 0 && cur + cl.groups.length <= limit) {
          canMerge = true;
          break;
        }
        cur = cl.groups.length;
      }

      if (canMerge) {
        wordStats.push({
          word: w,
          count: matching.length,
          clusters: sortedMatching
        });
      }
    }

    if (wordStats.length === 0) break;

    wordStats.sort((a, b) => (b.count - a.count) || a.word.localeCompare(b.word));
    const winner = wordStats[0];

    const matchingSet = new Set(winner.clusters);
    const untouched = clusters.filter(c => !matchingSet.has(c));

    const merged = [];
    let curBatch = [];
    for (const cl of winner.clusters) {
      if (curBatch.length + cl.groups.length <= limit) {
        curBatch.push(...cl.groups);
      } else {
        if (curBatch.length > 0) {
          curBatch.sort((a, b) => a.id.localeCompare(b.id));
          merged.push({ groups: curBatch, mergedByWord: true, dominantWord: winner.word });
        }
        curBatch = [...cl.groups];
      }
    }
    if (curBatch.length > 0) {
      curBatch.sort((a, b) => a.id.localeCompare(b.id));
      merged.push({ groups: curBatch, mergedByWord: true, dominantWord: winner.word });
    }

    clusters = [...untouched, ...merged];
  }

  const keptGroups = [];
  const leftoverClusters = [];

  for (const cl of clusters) {
    if (cl.groups.length >= 5) {
      keptGroups.push(cl);
    } else if (cl.mergedByWord && cl.groups.length >= 3) {
      keptGroups.push(cl);
    } else {
      leftoverClusters.push(cl);
    }
  }

  function getClusterHub(cl) {
    const hubCounts = new Map();
    for (const g of cl.groups) {
      for (const nbr of adj.get(g.id)) {
        if (coreGroupIds.has(nbr)) {
          hubCounts.set(nbr, (hubCounts.get(nbr) || 0) + 1);
        }
      }
    }
    if (hubCounts.size === 0) return "";
    const sorted = [...hubCounts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    return sorted[0][0];
  }

  leftoverClusters.sort((a, b) => {
    const hubA = getClusterHub(a);
    const hubB = getClusterHub(b);
    if (hubA !== hubB) {
      if (!hubA) return 1;
      if (!hubB) return -1;
      return hubA.localeCompare(hubB);
    }
    return a.groups[0].id.localeCompare(b.groups[0].id);
  });

  const leftoverGroupsList = leftoverClusters.flatMap(c => c.groups);
  const binSizes = computeBinSizes(leftoverGroupsList.length, limit);
  const packedLeftovers = [];
  let off = 0;
  for (const sz of binSizes) {
    const bin = leftoverGroupsList.slice(off, off + sz);
    off += sz;
    bin.sort((a, b) => a.id.localeCompare(b.id));
    packedLeftovers.push({ groups: bin, mergedByWord: false });
  }

  clusters = [...keptGroups, ...packedLeftovers];

  const finalClusters = [];
  for (const cl of clusters) {
    if (cl.groups.length <= limit) {
      finalClusters.push(cl);
      continue;
    }

    const unassigned = new Set(cl.groups.map(g => g.id));
    const clGroupMap = new Map(cl.groups.map(g => [g.id, g]));
    const sortedCandidates = [...cl.groups].sort((a, b) => (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id));
    let candIdx = 0;

    while (unassigned.size > 0) {
      if (unassigned.size <= limit) {
        const rem = sortedCandidates.filter(g => unassigned.has(g.id));
        finalClusters.push({ groups: rem, mergedByWord: cl.mergedByWord, dominantWord: cl.dominantWord });
        break;
      }

      while (candIdx < sortedCandidates.length && !unassigned.has(sortedCandidates[candIdx].id)) {
        candIdx++;
      }
      const seedGroup = sortedCandidates[candIdx];

      const groupList = [seedGroup];
      const groupSet = new Set([seedGroup.id]);
      const bfsQueue = [seedGroup.id];

      while (groupList.length < limit) {
        if (bfsQueue.length === 0) {
          let nextIdx = candIdx;
          while (nextIdx < sortedCandidates.length && (!unassigned.has(sortedCandidates[nextIdx].id) || groupSet.has(sortedCandidates[nextIdx].id))) {
            nextIdx++;
          }
          if (nextIdx >= sortedCandidates.length) break;
          const nextSeed = sortedCandidates[nextIdx];
          groupSet.add(nextSeed.id);
          groupList.push(nextSeed);
          bfsQueue.push(nextSeed.id);
        }

        const curr = bfsQueue.shift();
        const nbrs = [...(nonHubAdj.get(curr) || [])]
          .filter(nbrId => unassigned.has(nbrId) && !groupSet.has(nbrId))
          .sort((a, b) => (degrees.get(b) - degrees.get(a)) || a.localeCompare(b));

        for (const nbrId of nbrs) {
          if (groupList.length >= limit) break;
          groupSet.add(nbrId);
          groupList.push(clGroupMap.get(nbrId));
          bfsQueue.push(nbrId);
        }
      }

      for (const g of groupList) {
        unassigned.delete(g.id);
      }

      finalClusters.push({ groups: groupList, mergedByWord: cl.mergedByWord, dominantWord: cl.dominantWord });
    }
  }

  for (const cl of finalClusters) {
    const wordCounts = new Map();
    for (const g of cl.groups) {
      for (const w of groupWords.get(g.id)) {
        wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
      }
    }

    let dominantWord = null;
    let maxWCount = 0;
    const threshold = cl.groups.length * 0.6;
    for (const [w, cnt] of wordCounts.entries()) {
      if (cnt >= threshold) {
        if (cnt > maxWCount || (cnt === maxWCount && (dominantWord === null || w.localeCompare(dominantWord) < 0))) {
          dominantWord = w;
          maxWCount = cnt;
        }
      }
    }

    if (dominantWord) {
      const cap = dominantWord.charAt(0).toUpperCase() + dominantWord.slice(1);
      cl.baseName = `${cap} area`;
    } else {
      let allHub = null;
      if (coreGroups.length > 0) {
        for (const hub of coreGroups) {
          const allRel = cl.groups.every(g => adj.get(g.id).has(hub.id));
          if (allRel) {
            allHub = hub;
            break;
          }
        }
      }

      if (allHub) {
        const hubLabel = allHub.name.replace(/\s+group$/i, "").replace(/\s+models$/i, "").replace(/\s+area$/i, "");
        cl.baseName = `${hubLabel}-related area`;
      } else {
        const sorted = [...cl.groups].sort((a, b) =>
          (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id)
        );
        cl.lead = sorted[0];
        const leadLabel = cl.lead.name.replace(/\s+group$/i, "").replace(/\s+models$/i, "").replace(/\s+area$/i, "");
        cl.baseName = `${leadLabel} area`;
      }
    }

    if (!cl.lead) {
      const sorted = [...cl.groups].sort((a, b) =>
        (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id)
      );
      cl.lead = sorted[0];
    }
  }

  finalClusters.sort((a, b) =>
    (degrees.get(b.lead.id) - degrees.get(a.lead.id)) ||
    a.baseName.localeCompare(b.baseName) ||
    a.lead.id.localeCompare(b.lead.id)
  );

  const nameCounts = new Map();
  const metaGroups = [];

  if (coreGroups.length > 0) {
    metaGroups.push({
      id: "core-area",
      name: "Core area",
      groups: coreGroups,
      lead: coreGroups[0].lead || coreGroups[0]
    });
  }

  for (const cl of finalClusters) {
    const base = cl.baseName;
    const cnt = (nameCounts.get(base) || 0) + 1;
    nameCounts.set(base, cnt);
    const name = cnt === 1 ? base : `${base} (${cnt})`;
    const id = toGroupId(name);
    metaGroups.push({
      id,
      name,
      groups: cl.groups,
      lead: cl.lead
    });
  }

  const edgesByGroup = new Map();
  for (const g of groups) edgesByGroup.set(g.id, []);
  for (const e of (originalEdges || [])) {
    const gFrom = nodeToGroup.get(e.from);
    const gTo = nodeToGroup.get(e.to);
    if (!gFrom || !gTo || gFrom.id === gTo.id) continue;
    edgesByGroup.get(gFrom.id)?.push(e);
    edgesByGroup.get(gTo.id)?.push(e);
  }

  for (const mg of metaGroups) {
    mg.nodes = mg.groups.flatMap(g => g.nodes);
    mg.lead = mg.lead?.lead || mg.lead || mg.groups[0]?.lead || mg.groups[0];

    const subNodes = mg.groups.map(g => {
      const displayNames = g.nodes.map(n => n.label ? n.label.split("\n")[0].trim() : n.id);
      const first10 = displayNames.slice(0, 10);
      const remaining = displayNames.length - 10;
      const tooltip = remaining > 0 ? `${first10.join(", ")}, +${remaining} more` : first10.join(", ");

      return {
        id: g.id,
        label: `${g.name}\n${g.nodes.length} models`,
        shape: "rectangle",
        color: "blue",
        tooltip,
        drill: g.drill
      };
    });

    const mgGroupIds = new Set(mg.groups.map(g => g.id));
    const internalPairs = new Map();
    const seenEdges = new Set();

    for (const g of mg.groups) {
      for (const e of (edgesByGroup.get(g.id) || [])) {
        if (seenEdges.has(e)) continue;
        seenEdges.add(e);
        const gFrom = nodeToGroup.get(e.from);
        const gTo = nodeToGroup.get(e.to);
        if (!gFrom || !gTo || gFrom.id === gTo.id) continue;
        if (!mgGroupIds.has(gFrom.id) || !mgGroupIds.has(gTo.id)) continue;

        const [gA, gB] = gFrom.id < gTo.id ? [gFrom, gTo] : [gTo, gFrom];
        const key = `${gA.id}:::${gB.id}`;
        if (!internalPairs.has(key)) {
          internalPairs.set(key, { gA, gB, total: 0, aToB: 0, bToA: 0 });
        }
        const entry = internalPairs.get(key);
        entry.total++;
        if (gFrom.id === gA.id) entry.aToB++;
        else entry.bToA++;
      }
    }

    const subEdges = [];
    const sortedInternal = [...internalPairs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [, entry] of sortedInternal) {
      let fromId = entry.gA.id;
      let toId = entry.gB.id;
      if (entry.bToA > entry.aToB) {
        fromId = entry.gB.id;
        toId = entry.gA.id;
      }
      subEdges.push({
        from: fromId,
        to: toId,
        label: `${entry.total} relations`,
        style: "solid"
      });
    }

    mg.drill = {
      title: mg.name,
      direction: spec.direction || "LR",
      preset: spec.preset || "clean",
      ...(spec.style ? { style: spec.style } : {}),
      nodes: subNodes,
      edges: subEdges
    };
  }

  return metaGroups;
}

export function splitLargeSpec(spec, { maxNodes = 15 } = {}) {
  const limit = Math.max(1, Number(maxNodes) || 15);
  if (!spec || !Array.isArray(spec.nodes) || spec.nodes.length <= limit) {
    return spec;
  }

  const nodes = spec.nodes;
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  // 1a. Undirected relation graph from spec.edges
  const adj = new Map();
  for (const n of nodes) {
    adj.set(n.id, new Set());
  }

  for (const e of (spec.edges || [])) {
    if (e && e.from && e.to && e.from !== e.to && nodeMap.has(e.from) && nodeMap.has(e.to)) {
      adj.get(e.from).add(e.to);
      adj.get(e.to).add(e.from);
    }
  }

  const degrees = new Map();
  for (const n of nodes) {
    degrees.set(n.id, adj.get(n.id).size);
  }

  // 1b. Hubs: nodes whose degree is >= max(8, 3 x median degree) -> Core
  const degList = nodes.map(n => degrees.get(n.id)).sort((a, b) => a - b);
  const mid = Math.floor(degList.length / 2);
  const medianDegree = degList.length % 2 === 0
    ? (degList[mid - 1] + degList[mid]) / 2
    : degList[mid];

  const hubThreshold = Math.max(8, 3 * medianDegree);

  const candidateHubs = nodes.filter(n => degrees.get(n.id) >= hubThreshold);
  candidateHubs.sort((a, b) => (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id));

  const coreNodes = candidateHubs.slice(0, limit);
  const coreNodeIds = new Set(coreNodes.map(n => n.id));

  // 2. Seed clusters = connected components of the non-hub graph (hub edges ignored)
  const nonCoreNodes = nodes.filter(n => !coreNodeIds.has(n.id));
  const nonCoreNodeMap = new Map(nonCoreNodes.map(n => [n.id, n]));

  const nonHubAdj = new Map();
  for (const n of nonCoreNodes) {
    nonHubAdj.set(n.id, new Set());
  }
  for (const n of nonCoreNodes) {
    for (const nbr of adj.get(n.id)) {
      if (!coreNodeIds.has(nbr)) {
        nonHubAdj.get(n.id).add(nbr);
      }
    }
  }

  const sortedNonCore = [...nonCoreNodes].sort((a, b) => a.id.localeCompare(b.id));
  const visited = new Set();
  const seedClusters = [];

  for (const startNode of sortedNonCore) {
    if (visited.has(startNode.id)) continue;
    const comp = [];
    const queue = [startNode.id];
    visited.add(startNode.id);

    while (queue.length > 0) {
      const curr = queue.shift();
      comp.push(nonCoreNodeMap.get(curr));
      const nbrs = [...nonHubAdj.get(curr)].sort((a, b) => a.localeCompare(b));
      for (const nbr of nbrs) {
        if (!visited.has(nbr)) {
          visited.add(nbr);
          queue.push(nbr);
        }
      }
    }
    comp.sort((a, b) => a.id.localeCompare(b.id));
    seedClusters.push({ models: comp, mergedByWord: false });
  }

  // 3. Name words for each model
  const nodeWords = new Map();
  for (const n of nodes) {
    nodeWords.set(n.id, extractWords(n));
  }

  // 4. Merge by shared word: while any cluster has < 5 models, find the word shared by the most clusters that contain a < 5 cluster;
  // merge all clusters containing that word in order of id, as long as the merged size stays <= maxNodes.
  let clusters = seedClusters.map(c => ({
    models: [...c.models],
    mergedByWord: false
  }));

  function clusterHasWord(cl, word) {
    return cl.models.some(m => nodeWords.get(m.id).has(word));
  }

  while (true) {
    const smallClusters = clusters.filter(c => c.models.length < 5);
    if (smallClusters.length === 0) break;

    const candidateWords = new Set();
    for (const c of smallClusters) {
      for (const m of c.models) {
        for (const w of nodeWords.get(m.id)) {
          candidateWords.add(w);
        }
      }
    }

    if (candidateWords.size === 0) break;

    const wordStats = [];
    for (const w of candidateWords) {
      const matching = clusters.filter(c => clusterHasWord(c, w));
      if (matching.length < 2) continue;

      const sortedMatching = [...matching].sort((a, b) =>
        getClusterId(a).localeCompare(getClusterId(b))
      );

      // Check if at least one merge can occur
      let canMerge = false;
      let cur = 0;
      for (const cl of sortedMatching) {
        if (cur > 0 && cur + cl.models.length <= limit) {
          canMerge = true;
          break;
        }
        cur = cl.models.length;
      }

      if (canMerge) {
        wordStats.push({
          word: w,
          count: matching.length,
          clusters: sortedMatching
        });
      }
    }

    if (wordStats.length === 0) break;

    // Tie breaks: larger count, then word alphabetical
    wordStats.sort((a, b) => (b.count - a.count) || a.word.localeCompare(b.word));
    const winner = wordStats[0];

    const matchingSet = new Set(winner.clusters);
    const untouched = clusters.filter(c => !matchingSet.has(c));

    const merged = [];
    let curBatch = [];
    for (const cl of winner.clusters) {
      if (curBatch.length + cl.models.length <= limit) {
        curBatch.push(...cl.models);
      } else {
        if (curBatch.length > 0) {
          curBatch.sort((a, b) => a.id.localeCompare(b.id));
          merged.push({ models: curBatch, mergedByWord: true, dominantWord: winner.word });
        }
        curBatch = [...cl.models];
      }
    }
    if (curBatch.length > 0) {
      curBatch.sort((a, b) => a.id.localeCompare(b.id));
      merged.push({ models: curBatch, mergedByWord: true, dominantWord: winner.word });
    }

    clusters = [...untouched, ...merged];
  }

  // 5. Pack leftovers: clusters still < 5 are packed in order (first by the hub they relate to, then by id) into bins of <= maxNodes.
  // Clusters that were successfully formed by word merge (with >= 3 models and dominant word) are kept.
  const keptGroups = [];
  const leftoverClusters = [];

  for (const cl of clusters) {
    if (cl.models.length >= 5) {
      keptGroups.push(cl);
    } else if (cl.mergedByWord && cl.models.length >= 3) {
      keptGroups.push(cl);
    } else {
      leftoverClusters.push(cl);
    }
  }

  function getClusterHub(cl) {
    const hubCounts = new Map();
    for (const m of cl.models) {
      for (const nbr of adj.get(m.id)) {
        if (coreNodeIds.has(nbr)) {
          hubCounts.set(nbr, (hubCounts.get(nbr) || 0) + 1);
        }
      }
    }
    if (hubCounts.size === 0) return "";
    const sorted = [...hubCounts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    return sorted[0][0];
  }

  leftoverClusters.sort((a, b) => {
    const hubA = getClusterHub(a);
    const hubB = getClusterHub(b);
    if (hubA !== hubB) {
      if (!hubA) return 1;
      if (!hubB) return -1;
      return hubA.localeCompare(hubB);
    }
    return getClusterId(a).localeCompare(getClusterId(b));
  });

  const leftoverModels = leftoverClusters.flatMap(c => c.models);
  const binSizes = computeBinSizes(leftoverModels.length, limit);
  const packedLeftovers = [];
  let off = 0;
  for (const sz of binSizes) {
    const bin = leftoverModels.slice(off, off + sz);
    off += sz;
    bin.sort((a, b) => a.id.localeCompare(b.id));
    packedLeftovers.push({ models: bin, mergedByWord: false });
  }

  clusters = [...keptGroups, ...packedLeftovers];

  // 6. Large clusters (> maxNodes) split as before (highest-degree BFS)
  const finalClusters = [];
  for (const cl of clusters) {
    if (cl.models.length <= limit) {
      finalClusters.push(cl);
      continue;
    }

    const unassigned = new Set(cl.models.map(n => n.id));
    const sortedCandidates = [...cl.models].sort((a, b) => (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id));
    let candIdx = 0;

    while (unassigned.size > 0) {
      if (unassigned.size <= limit) {
        const rem = sortedCandidates.filter(m => unassigned.has(m.id));
        finalClusters.push({ models: rem, mergedByWord: cl.mergedByWord, dominantWord: cl.dominantWord });
        break;
      }

      while (candIdx < sortedCandidates.length && !unassigned.has(sortedCandidates[candIdx].id)) {
        candIdx++;
      }
      const seedNode = sortedCandidates[candIdx];

      const groupNodes = [seedNode];
      const groupSet = new Set([seedNode.id]);
      const bfsQueue = [seedNode.id];

      while (groupNodes.length < limit) {
        if (bfsQueue.length === 0) {
          let nextIdx = candIdx;
          while (nextIdx < sortedCandidates.length && (!unassigned.has(sortedCandidates[nextIdx].id) || groupSet.has(sortedCandidates[nextIdx].id))) {
            nextIdx++;
          }
          if (nextIdx >= sortedCandidates.length) break;
          const nextSeed = sortedCandidates[nextIdx];
          groupSet.add(nextSeed.id);
          groupNodes.push(nextSeed);
          bfsQueue.push(nextSeed.id);
        }

        const curr = bfsQueue.shift();
        const nbrs = [...(nonHubAdj.get(curr) || [])]
          .filter(nbrId => unassigned.has(nbrId) && !groupSet.has(nbrId))
          .sort((a, b) => (degrees.get(b) - degrees.get(a)) || a.localeCompare(b));

        for (const nbrId of nbrs) {
          if (groupNodes.length >= limit) break;
          groupSet.add(nbrId);
          groupNodes.push(nodeMap.get(nbrId));
          bfsQueue.push(nbrId);
        }
      }

      for (const n of groupNodes) {
        unassigned.delete(n.id);
      }

      finalClusters.push({ models: groupNodes, mergedByWord: cl.mergedByWord, dominantWord: cl.dominantWord });
    }
  }

  // 7. Names:
  // if >= 60% of a group's models contain one word, "<Word> models" (capitalised, e.g. "Attempt models");
  // else if all relate to one hub, "<Hub>-related";
  // else "<highest-degree model> group".
  // Numbered "(2)", "(3)" only on clashes. Core stays "Core".
  for (const cl of finalClusters) {
    const wordCounts = new Map();
    for (const m of cl.models) {
      for (const w of nodeWords.get(m.id)) {
        wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
      }
    }

    let dominantWord = null;
    let maxWCount = 0;
    const threshold = cl.models.length * 0.6;
    for (const [w, cnt] of wordCounts.entries()) {
      if (cnt >= threshold) {
        if (cnt > maxWCount || (cnt === maxWCount && (dominantWord === null || w.localeCompare(dominantWord) < 0))) {
          dominantWord = w;
          maxWCount = cnt;
        }
      }
    }

    if (dominantWord) {
      const cap = dominantWord.charAt(0).toUpperCase() + dominantWord.slice(1);
      cl.baseName = `${cap} models`;
    } else {
      let allHub = null;
      if (coreNodes.length > 0) {
        for (const hub of coreNodes) {
          const allRel = cl.models.every(m => adj.get(m.id).has(hub.id));
          if (allRel) {
            allHub = hub;
            break;
          }
        }
      }

      if (allHub) {
        const hubLabel = (allHub.label || "").split("\n")[0].trim();
        const hubName = hubLabel || (allHub.id.charAt(0).toUpperCase() + allHub.id.slice(1));
        cl.baseName = `${hubName}-related`;
      } else {
        const sorted = [...cl.models].sort((a, b) =>
          (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id)
        );
        cl.lead = sorted[0];
        const leadName = cl.lead.label ? cl.lead.label.split("\n")[0].trim() : cl.lead.id;
        cl.baseName = `${leadName} group`;
      }
    }

    if (!cl.lead) {
      const sorted = [...cl.models].sort((a, b) =>
        (degrees.get(b.id) - degrees.get(a.id)) || a.id.localeCompare(b.id)
      );
      cl.lead = sorted[0];
    }
  }

  // Sort groups deterministically
  finalClusters.sort((a, b) =>
    (degrees.get(b.lead.id) - degrees.get(a.lead.id)) ||
    a.baseName.localeCompare(b.baseName) ||
    a.lead.id.localeCompare(b.lead.id)
  );

  const nameCounts = new Map();
  const allGroups = [];

  if (coreNodes.length > 0) {
    allGroups.push({
      id: "core",
      name: "Core",
      nodes: coreNodes,
      lead: coreNodes[0]
    });
  }

  for (const cl of finalClusters) {
    const base = cl.baseName;
    const cnt = (nameCounts.get(base) || 0) + 1;
    nameCounts.set(base, cnt);
    const name = cnt === 1 ? base : `${base} (${cnt})`;
    const id = toGroupId(name);
    allGroups.push({
      id,
      name,
      nodes: cl.models,
      lead: cl.lead
    });
  }

  const nodeToGroup = new Map();
  for (const g of allGroups) {
    for (const n of g.nodes) {
      nodeToGroup.set(n.id, g);
    }
  }

  const edgesByNode = new Map();
  for (const n of nodes) edgesByNode.set(n.id, []);
  for (const e of (spec.edges || [])) {
    if (e && e.from && e.to && nodeMap.has(e.from) && nodeMap.has(e.to)) {
      edgesByNode.get(e.from)?.push(e);
      edgesByNode.get(e.to)?.push(e);
    }
  }

  // 8. Core sub-diagram: hubs + ONE stub per other group (↗ <group name> (<k> models)), not one per model.
  // Other groups: stubs per external model as before, but at most 8 (then one ↗ +N more stub).
  for (const g of allGroups) {
    const gNodeIds = new Set(g.nodes.map(n => n.id));
    const subEdges = [];
    const gIncidentEdges = [];
    const seenEdges = new Set();
    for (const n of g.nodes) {
      for (const e of (edgesByNode.get(n.id) || [])) {
        if (!seenEdges.has(e)) {
          seenEdges.add(e);
          gIncidentEdges.push(e);
        }
      }
    }

    if (g.name === "Core") {
      for (const e of gIncidentEdges) {
        if (gNodeIds.has(e.from) && gNodeIds.has(e.to)) {
          subEdges.push(e);
        }
      }

      const otherGroupEdges = new Map();
      for (const e of gIncidentEdges) {
        const fromIn = gNodeIds.has(e.from);
        const toIn = gNodeIds.has(e.to);
        if (fromIn && !toIn) {
          const og = nodeToGroup.get(e.to);
          if (og && og.id !== g.id) {
            if (!otherGroupEdges.has(og.id)) otherGroupEdges.set(og.id, { group: og, edges: [] });
            otherGroupEdges.get(og.id).edges.push({ edge: e, dir: "out" });
          }
        } else if (!fromIn && toIn) {
          const og = nodeToGroup.get(e.from);
          if (og && og.id !== g.id) {
            if (!otherGroupEdges.has(og.id)) otherGroupEdges.set(og.id, { group: og, edges: [] });
            otherGroupEdges.get(og.id).edges.push({ edge: e, dir: "in" });
          }
        }
      }

      const coreStubs = [];
      const sortedOtherGroupEntries = [...otherGroupEdges.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [ogId, data] of sortedOtherGroupEntries) {
        const og = data.group;
        const stubId = `ext:group:${ogId}`;
        const stubLabel = `↗ ${og.name} (${og.nodes.length} ${plural(og.nodes.length, "model")})`;
        coreStubs.push({
          id: stubId,
          label: stubLabel,
          shape: "rectangle",
          color: "gray",
          tooltip: `in ${og.name}`
        });

        const edgesByHub = new Map();
        for (const item of data.edges) {
          const hubId = item.dir === "out" ? item.edge.from : item.edge.to;
          if (!edgesByHub.has(hubId)) edgesByHub.set(hubId, []);
          edgesByHub.get(hubId).push(item);
        }

        for (const [hubId, hEdges] of edgesByHub.entries()) {
          const first = hEdges[0];
          const totalRels = hEdges.length;
          const edgeLabel = totalRels === 1 ? (first.edge.label || "1 relation") : `${totalRels} ${plural(totalRels, "relation")}`;

          if (first.dir === "out") {
            subEdges.push({
              from: hubId,
              to: stubId,
              label: edgeLabel,
              style: "solid"
            });
          } else {
            subEdges.push({
              from: stubId,
              to: hubId,
              label: edgeLabel,
              style: "solid"
            });
          }
        }
      }

      g.drill = {
        title: g.name,
        direction: spec.direction || "LR",
        preset: spec.preset || "clean",
        ...(spec.style ? { style: spec.style } : {}),
        nodes: [...g.nodes, ...coreStubs],
        edges: subEdges
      };
    } else {
      const extModelMap = new Map();
      for (const e of gIncidentEdges) {
        const fromIn = gNodeIds.has(e.from);
        const toIn = gNodeIds.has(e.to);
        if (fromIn && toIn) {
          subEdges.push(e);
        } else if (fromIn && !toIn) {
          const outNode = nodeMap.get(e.to);
          if (outNode) {
            if (!extModelMap.has(outNode.id)) {
              extModelMap.set(outNode.id, { node: outNode, group: nodeToGroup.get(outNode.id), edges: [] });
            }
            extModelMap.get(outNode.id).edges.push({ edge: e, dir: "out" });
          }
        } else if (!fromIn && toIn) {
          const outNode = nodeMap.get(e.from);
          if (outNode) {
            if (!extModelMap.has(outNode.id)) {
              extModelMap.set(outNode.id, { node: outNode, group: nodeToGroup.get(outNode.id), edges: [] });
            }
            extModelMap.get(outNode.id).edges.push({ edge: e, dir: "in" });
          }
        }
      }

      const extEntries = [...extModelMap.values()];
      extEntries.sort((a, b) => (b.edges.length - a.edges.length) || a.node.id.localeCompare(b.node.id));

      const subNodes = [...g.nodes];

      if (extEntries.length <= 8) {
        for (const entry of extEntries) {
          const outNode = entry.node;
          const og = entry.group;
          const modelName = outNode.label ? outNode.label.split("\n")[0].trim() : outNode.id;
          const stubId = `ext:${outNode.id}`;
          subNodes.push({
            id: stubId,
            label: `↗ ${modelName}`,
            shape: outNode.shape || "rectangle",
            color: "gray",
            tooltip: `in ${og ? og.name : "other group"}`
          });
          for (const item of entry.edges) {
            if (item.dir === "out") {
              subEdges.push({ ...item.edge, to: stubId });
            } else {
              subEdges.push({ ...item.edge, from: stubId });
            }
          }
        }
      } else {
        const top8 = extEntries.slice(0, 8);
        const remaining = extEntries.slice(8);

        for (const entry of top8) {
          const outNode = entry.node;
          const og = entry.group;
          const modelName = outNode.label ? outNode.label.split("\n")[0].trim() : outNode.id;
          const stubId = `ext:${outNode.id}`;
          subNodes.push({
            id: stubId,
            label: `↗ ${modelName}`,
            shape: outNode.shape || "rectangle",
            color: "gray",
            tooltip: `in ${og ? og.name : "other group"}`
          });
          for (const item of entry.edges) {
            if (item.dir === "out") {
              subEdges.push({ ...item.edge, to: stubId });
            } else {
              subEdges.push({ ...item.edge, from: stubId });
            }
          }
        }

        const moreCount = remaining.length;
        const moreStubId = `ext:more:${g.id}`;
        subNodes.push({
          id: moreStubId,
          label: `↗ +${moreCount} more`,
          shape: "rectangle",
          color: "gray",
          tooltip: `in other groups`
        });

        for (const entry of remaining) {
          for (const item of entry.edges) {
            if (item.dir === "out") {
              subEdges.push({ ...item.edge, to: moreStubId });
            } else {
              subEdges.push({ ...item.edge, from: moreStubId });
            }
          }
        }
      }

      g.drill = {
        title: g.name,
        direction: spec.direction || "LR",
        preset: spec.preset || "clean",
        ...(spec.style ? { style: spec.style } : {}),
        nodes: subNodes,
        edges: subEdges
      };
    }
  }

  let currentGroups = allGroups;
  while (currentGroups.length > limit) {
    currentGroups = clusterGroupsLevel(currentGroups, spec.edges || [], limit, spec);
  }

  // Overview spec
  const overviewNodes = currentGroups.map(g => {
    const displayNames = g.nodes.map(n => n.label ? n.label.split("\n")[0].trim() : n.id);
    const first10 = displayNames.slice(0, 10);
    const remaining = displayNames.length - 10;
    const tooltip = remaining > 0 ? `${first10.join(", ")}, +${remaining} more` : first10.join(", ");

    return {
      id: g.id,
      label: `${g.name}\n${g.nodes.length} models`,
      shape: "rectangle",
      color: "blue",
      tooltip,
      drill: g.drill
    };
  });

  const nodeToTopGroup = new Map();
  for (const g of currentGroups) {
    for (const n of g.nodes) {
      nodeToTopGroup.set(n.id, g);
    }
  }

  const pairMap = new Map();
  for (const e of (spec.edges || [])) {
    const gFrom = nodeToTopGroup.get(e.from);
    const gTo = nodeToTopGroup.get(e.to);
    if (!gFrom || !gTo || gFrom.id === gTo.id) continue;

    const [gA, gB] = gFrom.id < gTo.id ? [gFrom, gTo] : [gTo, gFrom];
    const key = `${gA.id}:::${gB.id}`;
    if (!pairMap.has(key)) {
      pairMap.set(key, { gA, gB, total: 0, aToB: 0, bToA: 0 });
    }
    const entry = pairMap.get(key);
    entry.total++;
    if (gFrom.id === gA.id) entry.aToB++;
    else entry.bToA++;
  }

  const overviewEdges = [];
  const sortedPairs = [...pairMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, entry] of sortedPairs) {
    let fromId = entry.gA.id;
    let toId = entry.gB.id;
    if (entry.bToA > entry.aToB) {
      fromId = entry.gB.id;
      toId = entry.gA.id;
    }
    overviewEdges.push({
      from: fromId,
      to: toId,
      label: `${entry.total} relations`,
      style: "solid"
    });
  }

  return {
    title: spec.title,
    direction: spec.direction || "LR",
    preset: spec.preset || "clean",
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    ...(spec.style ? { style: spec.style } : {}),
    nodes: overviewNodes,
    edges: overviewEdges
  };
}
