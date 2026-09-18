import { basename, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { selectNotificationTarget } from "@grokbox/runtime-kernel/observation";
import { openConfigStore } from "../../src/internal/io/config-store.node.ts";
import { rootConfigLayout } from "../../src/internal/io/config-layout.node.ts";
import { openMonitorStore } from "../../src/internal/io/monitor-store.node.ts";

const [root, workId, phase] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !basename(root).startsWith("ops-delivery-") || !workId || !["reserved", "attempting"].includes(phase ?? "")) throw Error("owned_fixture_required");
const store = openMonitorStore(root), scope = await store.notificationScope();
const route = selectNotificationTarget(effectiveOps((await openConfigStore(rootConfigLayout(root)).read()).document.ops));
if (route.state !== "selected") throw Error("fixture_route_unavailable");
const nowMs = Date.now(), target = route.target;
const result = await store.reserveNotification({ workId, target, nowMs, binding: { ...scope, bindingId: randomUUID(), revision: 1,
  targetAlias: target.alias, agentId: target.agentId, routineKey: target.routineKey, routineId: "notice-1", routineRevision: "c".repeat(64),
  modelRevision: "d".repeat(64), qualificationRevision: "e".repeat(64), policyRevision: target.policyRevision,
  dataPolicy: "safe-summary", receiverMode: "notify_then_end", observedAtMs: nowMs, validUntilMs: nowMs + 5000 } });
if (result.state !== "reserved") throw Error("fixture_reserve_failed");
if (phase === "attempting") await store.beginNotification({ workId, attemptId: result.frozen.attemptId,
  envelopeDigest: result.frozen.envelopeDigest, bindingDigest: result.frozen.bindingDigest, nowMs: Date.now() });
// A blocking descriptor write publishes the stage before intentional death;
// do not depend on a runtime-specific stdout callback to trigger the crash.
writeSync(1, JSON.stringify({ phase, committed: true }) + "\n");
process.kill(process.pid, "SIGKILL");
