import { createPreparedNoticeDriver, type ExplicitReceiverReader } from "../../src/internal/roots/ops-explicit-delivery.runtime.ts";
import { runOpsNotificationDelivery } from "../../src/internal/roots/ops-notification.runtime.ts";
import type { NotificationRequest } from "../../src/internal/io/native-notification.node.ts";

/** Test-only composition of the original outbox and private driver. User
 * authorization/receipts are tested through the real management HTTP endpoint. */
export function deliverPreparedFixture(input: { durableRoot: string; workId: string; expectedBindingRevision: number;
  expectedModelRevision: string; readNative: ExplicitReceiverReader; signal?: AbortSignal }, ports: { request: NotificationRequest }) {
  const prepared = createPreparedNoticeDriver(input, ports);
  return runOpsNotificationDelivery({ durableRoot: input.durableRoot, workId: input.workId, driver: prepared.driver, signal: input.signal });
}
