import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createManagementGateway, publishConfigFile, type HostHealthTestPorts } from "@grokbox/box-runtime/runtime";
import { OWNERSHIP_READ_SLICES } from "../../../packages/box-runtime/src/internal/host/ownership-slices.ts";
import { hostHealthFixture } from "./host-health-fixture.ts";
import { launchPublicHost, stopPublicHost } from "./host-compilation-fixture.ts";
export async function hostWitnessFixture(origin: string, ports: HostHealthTestPorts = {}, mode: "identity" | "route" = "identity") {
  let reader: ReturnType<typeof createManagementGateway>["readHostWitness"] | undefined;
  const state = { calls: 0, aborted: 0, decorate: undefined as undefined | ((reply: { value: unknown; pid: number }) => { value: unknown; pid: number }) };
  const f = await hostHealthFixture(origin, { ports: { witnessPollMs: 25, ...ports }, readWitness: async (challenge, signal) => {
    if (!reader) throw Error("synthetic-native-starting"); state.calls++;
    const abort = () => { state.aborted++; }; signal.addEventListener("abort", abort, { once: true });
    try { const reply = await reader(challenge, signal); return state.decorate ? state.decorate(reply) : reply; }
    finally { signal.removeEventListener("abort", abort); }
  } });
  let process: Awaited<ReturnType<typeof launchPublicHost>> | undefined;
  try {
    const suffix = await readFile(join(globalThis.process.env.GROKBOX_TEST_FIXTURES!, "host-verifier/sources/witness-status.cjs"), "utf8");
    const source = f.source + "\n" + suffix;
    await writeFile(f.paths.source, source, { mode: 0o600 }); await f.writeProfile(source, [...f.slices, ...OWNERSHIP_READ_SLICES]);
    if (mode === "route") await f.options.store.saveModels(applyUse(parseModelsFile(undefined), "stub/echo", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    const discoveryPath = join(f.root, "witness-native.json"); let baseUrl = "";
    const startNative = async () => {
      process = await launchPublicHost(f, mode);
      let port: number | undefined; const end = Date.now() + 8000;
      while (!port && Date.now() < end) { try { port = JSON.parse(process.output().trim()).port; } catch {} if (!port) await new Promise(r => setTimeout(r, 10)); }
      if (!port) throw Error("synthetic-status-listen");
      await publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port, pid: process.child.pid!, startedAt: Date.now(), token: "synthetic-witness-native" });
      reader = createManagementGateway({ discoveryPath, configurationRoot: f.root }).readHostWitness;
      baseUrl = `http://127.0.0.1:${port}`;
    };
    await startNative();
    return { ...f, get server() { return f.server; }, probeState: state, get process() { return process!; }, get baseUrl() { return baseUrl; }, discoveryPath,
      restartNative: async () => { await stopPublicHost(process!.child); await startNative(); },
      control: async (action: string, extra: Record<string, unknown> = {}) => {
        const result = await fetch(`${baseUrl}/test/control`, { method: "POST", headers: { authorization: "Bearer synthetic-witness-native", "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }), signal: AbortSignal.timeout(8000) });
        if (!result.ok) throw Error("synthetic-control-refused"); return result.json() as Promise<{ nativeReads: number; getterReads: number; recorded: unknown }>;
      },
      close: async () => { await f.server.close(); await stopPublicHost(process!.child); await f.close(); } };
  } catch (error) { if (process) await stopPublicHost(process.child); await f.close(); throw error; }
}
