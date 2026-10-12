import type { WorkflowFile } from "@/store/workflowStore";

/**
 * The save request's body, built from per-node and per-edge JSON kept
 * between saves.
 *
 * The store replaces a node or edge object whenever it changes and keeps it
 * otherwise, so each object's JSON is computed once and reused until the
 * object is replaced. A save after a keystroke serialises the edited node
 * and joins the rest, instead of serialising the whole graph again.
 *
 * The result is the same string `JSON.stringify({ ...meta, workflow })`
 * would give.
 */
const cache = new WeakMap<object, string>();

function json(value: object): string {
  let text = cache.get(value);
  if (text === undefined) {
    text = JSON.stringify(value);
    cache.set(value, text);
  }
  return text;
}

function list(items: readonly object[]): string {
  const parts = new Array<string>(items.length);
  // JSON.stringify writes `null` for an array hole or a non-object.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    parts[i] = item !== null && typeof item === "object" ? json(item) : JSON.stringify(item ?? null);
  }
  return `[${parts.join(",")}]`;
}

const NODES = "\u0000nb-nodes\u0000";
const EDGES = "\u0000nb-edges\u0000";

export function serializeWorkflowRequest(meta: Record<string, unknown>, workflow: WorkflowFile): string {
  // The rest of the request is small: stringify it with markers where the
  // node and edge lists go, then put the lists in.
  const shell = JSON.stringify({ ...meta, workflow: { ...workflow, nodes: NODES, edges: EDGES } });
  const nodesAt = shell.indexOf(JSON.stringify(NODES));
  const edgesAt = shell.indexOf(JSON.stringify(EDGES));
  const marker = JSON.stringify(NODES).length;
  const [first, firstList, second, secondList] = nodesAt < edgesAt
    ? [nodesAt, list(workflow.nodes), edgesAt, list(workflow.edges)]
    : [edgesAt, list(workflow.edges), nodesAt, list(workflow.nodes)];
  return shell.slice(0, first) + firstList + shell.slice(first + marker, second) + secondList + shell.slice(second + marker);
}
