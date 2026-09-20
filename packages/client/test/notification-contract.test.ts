import { expect, test } from "bun:test";
import { ManagementClient } from "../src/client.ts";
import { randomUUID } from "node:crypto";
const I = "11111111-1111-4111-8111-111111111111";
const status = { owner: "management-server", state: "waiting", cycles: 1, lastCycleAtMs: 1000, nextDelayMs: 5000,
  lastCycle: { state: "blocked", reason: "automatic_not_authorized" }, automaticDiagnosis: false,
  automaticIssue: false, pollingCallsModels: false, serviceInstallation: "not_proven", botReport: "not_observed", userRead: "not_observed" } as const;
function client(data: unknown) {
  return new ManagementClient({ baseUrl: "http://127.0.0.1:1234", installationId: I,
    fetch: Object.assign(async () => Response.json({ schemaVersion: 1, installationId: I, invocationId: randomUUID(), ok: true, data }), { preconnect: () => undefined }) as typeof fetch });
}
test("notification status accepts only a bounded public worker observation, never consent or delivery proof", async () => {
  expect((await client(status).notificationWorker()).data).toEqual(status);
  for (const patch of [{ owner: "daemon-lifetime" }, { cycles: -1 }, { nextDelayMs: 300001 }, { userRead: "read" },
    { botReport: "completed" }, { automaticDiagnosis: true }, { serviceInstallation: "installed" }, { secret: "private" },
    { lastCycleAtMs: null }, { lastCycle: { ...status.lastCycle, authorizationId: randomUUID() } },
    { lastCycle: { state: "processed", reason: "attempt_settled", outcome: "delivered-to-user" } },
    { lastCycle: { state: "blocked", reason: "Error: private diagnostic" } }]) {
    await expect(client({ ...status, ...patch }).notificationWorker()).rejects.toMatchObject({ code: "protocol_error" });
  }
});
