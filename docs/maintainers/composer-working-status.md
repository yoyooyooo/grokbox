# Composer Working: unverified native behavior

Current App pixels and renderer behavior remain **unverified**. The old App 0.47 replay and private Gateway receipts are unavailable here and do not qualify a later renderer or bridge.

To investigate, correlate the same Bot, session, run/generation and time across Gateway run/activity fields, transcript streaming and the actual App view. Include pending sends, permission waits, success/failure/cancel and reconnection. A single `currentActivity` value cannot prove the rendered result.

The source-local callback boundary is tested separately by `packages/box-runtime/test/host-activity-bridge.test.ts`; it is not UI acceptance. [T36](../tickets/T36-composer-working-activity.md) retains the unresolved user-visible requirement, with current reported evidence in [LIVE](../tickets/LIVE-integration-validation.md#live-modeld-app).

Use [Working recovery](working-state-recovery.md) for scoped investigation and [App projections](host-app-projections.md) for evidence distinctions. Reloading, clearing caches or unloading Host is not proof of a fix.
