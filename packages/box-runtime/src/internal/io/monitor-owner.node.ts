import { readFile } from "node:fs/promises";
import { sha256Text } from "@grokbox/runtime-kernel/hash";

export async function monitorProcessIdentity(pid: number): Promise<{ state: "present"; start: string } | { state: "missing" | "unavailable" }> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return { state: "unavailable" };
  let text: string;
  try { text = await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (e) { return e && typeof e === "object" && "code" in e && e.code === "ENOENT" ? { state: "missing" } : { state: "unavailable" }; }
  try {
    const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (!/^\d+$/.test(fields[19] ?? "") || !boot.trim()) return { state: "unavailable" };
    return { state: "present", start: sha256Text(`${boot.trim()}:${fields[19]}`) };
  } catch { return { state: "unavailable" }; }
}
