import type { ProjectsElsewhere } from "@/lib/assets/types";
import { formatBytes } from "./assetFormat";

/**
 * Words for the Creativo Melborp folder's projects, shared by Settings › Storage
 * and the Assets view's offer to move projects in.
 */

/**
 * A home folder at the start of a path as "~": "/Users/ada/Documents/x" →
 * "~/Documents/x", "C:\Users\ada\x" → "~\x". The browser does not know the
 * server's home, so this recognises the usual places a home folder lives.
 */
export function shortenHomePath(path: string): string {
  const match = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/);
  return match ? `~${path.slice(match[0].length)}` : path;
}

/** A group's `~`-shortened folder as the offer names it: "~/test-files/test workflows" → "test-files › test workflows". */
export function groupLabel(label: string): string {
  const parts = label.replace(/^~(?=$|[\\/])/, "").split(/[\\/]+/).filter(Boolean);
  return parts.join(" › ") || label;
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "14 projects live in other folders". */
export function elsewhereTitle(elsewhere: ProjectsElsewhere): string {
  return elsewhere.count === 1 ? "1 project lives in another folder" : `${elsewhere.count.toLocaleString("en-US")} projects live in other folders`;
}

/**
 * Where they are: "test-files › test workflows (13) and pet-hype (1), 3.3 GB"
 * with counts and size (Settings), "test-files › test workflows and pet-hype"
 * without (the Assets view's one line).
 */
export function elsewhereWhere(elsewhere: ProjectsElsewhere, detail: boolean): string {
  const groups = elsewhere.groups.map((group) => (detail ? `${groupLabel(group.label)} (${group.count.toLocaleString("en-US")})` : groupLabel(group.label)));
  const where = joinAnd(groups);
  return detail && elsewhere.bytes > 0 ? `${where}, ${formatBytes(elsewhere.bytes)}` : where;
}

export const ELSEWHERE_PITCH = "Move them into your Creativo Melborp folder to keep everything in one place.";
