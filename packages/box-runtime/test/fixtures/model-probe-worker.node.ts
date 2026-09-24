import { openModelProbe, openRuntimeStore } from "../../src/runtime.ts";
const [root, requestJson] = process.argv.slice(2);
if (!root || !requestJson) throw new Error("Exact disposable probe input is required.");
await openModelProbe({
  store: openRuntimeStore(root, {}), installationId: "11111111-1111-4111-8111-111111111111",
  principalId: "probe-fixture", env: { PROBE_FIXTURE_KEY: "synthetic-probe-secret" },
}).probe(JSON.parse(requestJson), async () => undefined);
