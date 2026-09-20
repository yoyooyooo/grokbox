import { randomUUID } from "node:crypto";
import { makeMonitorSample } from "@grokbox/runtime-kernel/monitor";
import { ownedOwnershipSnapshot } from "../../../packages/box-runtime/test/ownership-fixture.ts";
import { FIRST, SECOND, type webFixture } from "./fixture.ts";

/** Only explicitly seeded synthetic observations; no installed collector or RPC. */
export async function seedObservations(f: Awaited<ReturnType<typeof webFixture>>, at = Date.now() - 1000) {
  const ids = [FIRST, SECOND], epoch = randomUUID();
  await f.observations.initialize();
  await f.observations.begin(epoch, at, ids);
  let sequence = 0;
  async function sample(time: number, serverHarness: "box" | "temporal" = "box") {
    const sample = makeMonitorSample({ sampleId: randomUUID(), agentIds: ids, startedAtMs: time, completedAtMs: time,
      response: { snapshot: ownedOwnershipSnapshot(ids, { nowMs: time, scopeId: "a".repeat(64), serverHarness, localHarness: "box" }),
        gateway: { pid: 42, startedAt: 1 } } });
    await f.observations.record(epoch, ++sequence, sample, "off");
  }
  await sample(at + 1);
  return { epoch, at, sample };
}
