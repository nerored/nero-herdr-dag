// Pure triage helpers shared by the renderer and the viewer. Keeping the
// filter/focus rules here means the graph, the summary chips, and the key
// handlers cannot disagree about what "failed" or "critical" means.

export const GRAPH_FILTERS = Object.freeze(['all', 'failed', 'blocked', 'running', 'critical']);

export function nodeState(node) {
  return node?.state ?? node?.status;
}

export function criticalNodeIds(summary) {
  return new Set(summary?.critical?.nodeIds ?? []);
}

export function nodeMatchesFilter(node, filter, criticalIds = new Set()) {
  const states = [nodeState(node), node?.status].filter(Boolean);
  switch (filter) {
    case 'failed':
      return states.includes('failed') || states.includes('error');
    case 'blocked':
      return states.includes('blocked') || states.includes('paused');
    case 'running':
      return states.includes('running');
    case 'critical':
      return criticalIds.has(node.id);
    default:
      return true;
  }
}

export function filterCounts(nodes = [], summary) {
  const criticalIds = criticalNodeIds(summary);
  const count = filter => nodes.filter(node => nodeMatchesFilter(node, filter, criticalIds)).length;
  return {
    all: nodes.length,
    failed: count('failed'),
    blocked: count('blocked'),
    running: count('running'),
    critical: criticalIds.size,
  };
}

// A focused graph is the selected node plus its direct predecessors and
// successors with the induced edges. Layout can then use the extra width for
// full labels instead of painting the whole DAG at once.
export function focusSubgraph(run, nodeId) {
  if (!run?.nodes?.length || !nodeId) return run;
  if (!run.nodes.some(node => node.id === nodeId)) return run;
  const ids = new Set([nodeId]);
  for (const edge of run.edges ?? []) {
    if (edge.from === nodeId) ids.add(edge.to);
    if (edge.to === nodeId) ids.add(edge.from);
  }
  return {
    ...run,
    nodes: run.nodes.filter(node => ids.has(node.id)),
    edges: (run.edges ?? []).filter(edge => ids.has(edge.from) && ids.has(edge.to)),
  };
}

export function nextNodeId(layout, currentId, delta) {
  const ids = [...(layout?.boxes?.values() ?? [])]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(box => box.node.id);
  if (!ids.length) return undefined;
  const index = ids.indexOf(currentId);
  const next = index < 0 ? 0 : (index + delta + ids.length) % ids.length;
  return ids[next];
}
