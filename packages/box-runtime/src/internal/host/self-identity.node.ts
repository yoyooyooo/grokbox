import { readFileSync, readlinkSync } from "node:fs";
import type { ProcessIdentity } from "../process/process-port.ts";

/** Inspect one pid. Host leaf must not import process census (list /proc). */
export function inspectPid(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    const rest = stat.slice(commEnd + 2).split(" ");
    const ppid = Number(rest[1]);
    const start = Number(rest[19]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uidLine = status.split("Uid:")[1];
    if (!uidLine) return null;
    const uid = Number(uidLine.trim().split(/\s+/)[0]);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    const exe = readlinkSync(`/proc/${pid}/exe`);
    const ancestry: number[] = [];
    let parent = ppid;
    for (let i = 0; i < 8 && parent > 1; i += 1) {
      ancestry.push(parent);
      const parentStat = readFileSync(`/proc/${parent}/stat`, "utf8");
      const parentEnd = parentStat.lastIndexOf(")");
      parent = Number(parentStat.slice(parentEnd + 2).split(" ")[1]);
    }
    return { pid, uid, start, exe, cmdline, ppid, ancestry };
  } catch {
    return null;
  }
}

export function inspectSelf(): ProcessIdentity | null {
  return inspectPid(process.pid);
}
