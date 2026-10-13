/**
 * Freezes the graph the store holds (nodes, edges, groups), deeply, so code
 * that changes it in place throws instead of silently rewriting history.
 *
 * Undo keeps the graph objects themselves rather than copies, which is only
 * sound while nothing mutates them. The tests turn this on; the app does not
 * pay for it.
 */
function isPlain(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function deepFreezeGraph(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value) || !isPlain(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreezeGraph((value as Record<string, unknown>)[key]);
}
