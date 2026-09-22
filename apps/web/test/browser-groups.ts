/** Disjoint production-browser windows. Every window keeps the same 150s
 * process-test budget and each journey keeps its existing assertion deadlines.
 * Adding a domain must assign it here rather than silently dropping a journey. */
export const BROWSER_GROUPS = {
  console: ["foundation", "jobs", "files", "desktop", "receivers", "setup"],
  state: ["materials", "protection", "lifecycle", "context", "compaction", "handover"],
  host: ["hostHealth"],
} as const;
export type BrowserGroup = keyof typeof BROWSER_GROUPS;
export function browserGroup(value: string | undefined): BrowserGroup {
  if (!value || !Object.hasOwn(BROWSER_GROUPS, value)) throw Error("Specify one registered production-browser window.");
  return value as BrowserGroup;
}
