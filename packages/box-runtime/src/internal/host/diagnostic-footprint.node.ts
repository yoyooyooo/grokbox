import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_ENTRIES = 2048, MAX_DEPTH = 4;
type Scope = "monitor" | "control_logs" | "host_logs";
type ScopeUsage = { scope: Scope; state: "measured" | "missing" | "partial"; fileBytes: number; allocatedBytes: number;
  files: number; directories: number; symlinks: number; sharedLinks: number };
/** Shared metadata-only leaf for status and writer admission. No file bodies,
 * deletion authorization, Effect, database or native business state. */
export async function observeDiagnosticFootprint(input: { durableRoot: string; runRoot?: string }) {
  const sources: Array<{ scope: Scope; root: string; name: string }> = [
    { scope: "monitor", root: resolve(input.durableRoot), name: "observability" },
    { scope: "control_logs", root: resolve(input.durableRoot), name: "log" },
  ];
  if (input.runRoot && resolve(input.runRoot) !== resolve(input.durableRoot)) sources.push({ scope: "host_logs", root: resolve(input.runRoot), name: "log" });
  const seen = new Set<string>(), scopes: ScopeUsage[] = [], gaps = new Set<string>();
  let entries = 0;
  for (const source of sources) {
    const usage: ScopeUsage = { scope: source.scope, state: "measured", fileBytes: 0, allocatedBytes: 0, files: 0, directories: 0, symlinks: 0, sharedLinks: 0 };
    scopes.push(usage);
    try {
      const root = await lstat(source.root);
      if (!root.isDirectory() || root.isSymbolicLink() || process.getuid && root.uid !== process.getuid()) throw Error("unsafe_root");
      const pending = [{ path: join(source.root, source.name), depth: 0 }];
      while (pending.length) {
        if (entries >= MAX_ENTRIES) { gaps.add("entry_budget"); usage.state = "partial"; break; }
        const next = pending.pop()!; entries++;
        let st;
        try { st = await lstat(next.path); }
        catch (e) {
          if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
            if (next.depth === 0) usage.state = "missing";
            else { usage.state = "partial"; gaps.add("changed_during_scan"); }
            continue;
          }
          usage.state = "partial"; gaps.add("metadata_unavailable"); continue;
        }
        if (st.isSymbolicLink()) { usage.symlinks++; usage.state = "partial"; gaps.add("symlink_not_followed"); continue; }
        if (process.getuid && st.uid !== process.getuid()) { usage.state = "partial"; gaps.add("foreign_owner_not_traversed"); continue; }
        const identity = `${st.dev}:${st.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (!st.isFile() && !st.isDirectory()) { usage.state = "partial"; gaps.add("special_file_not_followed"); continue; }
        usage.allocatedBytes += Number.isSafeInteger(st.blocks) && st.blocks >= 0 ? st.blocks * 512 : 0;
        if (!Number.isSafeInteger(st.blocks) || st.blocks < 0) { usage.state = "partial"; gaps.add("allocation_unavailable"); }
        if (st.isFile()) { usage.files++; usage.fileBytes += st.size; if (st.nlink > 1) usage.sharedLinks++; continue; }
        usage.directories++;
        if (next.depth >= MAX_DEPTH) { usage.state = "partial"; gaps.add("depth_budget"); continue; }
        const directory = await opendir(next.path);
        try {
          for (;;) {
            if (entries + pending.length >= MAX_ENTRIES) { usage.state = "partial"; gaps.add("entry_budget"); break; }
            const entry = await directory.read(); if (!entry) break;
            pending.push({ path: join(next.path, entry.name), depth: next.depth + 1 });
          }
        } finally { await directory.close(); }
        const after = await lstat(next.path);
        if (after.dev !== st.dev || after.ino !== st.ino || after.isSymbolicLink() || after.mtimeMs !== st.mtimeMs) {
          usage.state = "partial"; gaps.add("changed_during_scan");
        }
      }
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") usage.state = "missing";
      else { usage.state = "partial"; gaps.add("namespace_unavailable"); }
    }
  }
  return { scope: "explicit_diagnostic_namespaces" as const, state: gaps.size ? "partial" as const : "measured" as const,
    fileBytes: scopes.reduce((n, s) => n + s.fileBytes, 0), allocatedBytes: scopes.reduce((n, s) => n + s.allocatedBytes, 0),
    countedEntries: entries, maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH, scopes, gaps: [...gaps],
    hostScope: input.runRoot ? "configured" : "not_configured", sampling: "non_atomic_metadata_only", deletionAuthorized: false,
    installationBudgetEnforced: false, installationCoverage: "partial",
    unmeasuredOwners: ["jobs", "execution_safety", "recovery_snapshots", "artifacts", "exports_outside_diagnostic_namespaces"],
  };
}
