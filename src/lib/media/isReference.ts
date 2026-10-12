// Telling media held by reference apart (see references.ts). Kept free of
// imports so the media helpers it serves can use it without a cycle.

const ASSET_FILE = /^\/api\/assets\/[^/?#]+\/file(?:\?|$)/;
const WORKFLOW_FILE = /^\/api\/workflow-images\?(?=.*\braw=1\b)/;

/** A media string that stands for bytes on this computer rather than carrying them. */
export function isMediaReference(value: unknown): value is string {
  return typeof value === "string" && value.charCodeAt(0) === 47 /* "/" */ && (ASSET_FILE.test(value) || WORKFLOW_FILE.test(value));
}
