import { randomUUID } from "node:crypto";
import { receiverFixture, RECEIVER_INSTALLATION as I, RECEIVER_MODEL as MODEL } from "../../../apps/web/test/receiver-fixture.ts";

// All paths, credentials and native facts are created by this disposable fixture.
// Terminate only this test process, after the production OBS claim has committed.
const f = await receiverFixture("https://notification-crash.example.test");
const input = { notificationRef: `notification:${I}:${f.databaseId}:${await f.emit()}`, receiverRef: f.ref,
  requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: MODEL, confirmed: true as const };
f.ports.notification!.sendClaimed = async () => {
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify({ root: f.root, databaseId: f.databaseId, input }) + "\n", error => error ? reject(error) : resolve()));
  process.kill(process.pid, "SIGKILL");
  await new Promise<void>(() => undefined);
};
await f.client().sendNotification(input);
throw Error("test_process_should_have_stopped_after_original_claim");
