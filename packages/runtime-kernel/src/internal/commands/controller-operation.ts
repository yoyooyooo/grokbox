import { Cause, Effect } from "effect";
import { canonicalJson, sha256Text } from "../../hash.ts";
import {
  ControlResources,
  type ControllerReceipt,
  type ControllerRequest,
  type FrozenControllerCommand,
  type LaunchStrategy,
  type OperationPrefix,
  type OperationRecord,
} from "../../ports.ts";

const INTENTS = new Set(["preview", "apply", "reconcile"]);

export function fingerprintControllerCommand(input: {
  intent: string;
  operationId: string;
  boxRoot: string;
  strategy: LaunchStrategy | null;
  confirmed: boolean;
}): string {
  return sha256Text(canonicalJson({
    intent: input.intent,
    operationId: input.operationId,
    boxRoot: input.boxRoot,
    strategy: input.strategy,
    confirmed: input.confirmed,
  }));
}

export function admitControllerRequest(request: ControllerRequest): FrozenControllerCommand | null {
  if (!INTENTS.has(request.intent) || typeof request.operationId !== "string" || request.operationId.length === 0) {
    return null;
  }
  if (typeof request.boxRoot !== "string" || request.boxRoot.length === 0) return null;
  const strategy = request.strategy === "direct" || request.strategy === "transient" ? request.strategy : null;
  const command = {
    intent: request.intent,
    confirmed: request.confirmed === true,
    operationId: request.operationId,
    boxRoot: request.boxRoot,
    strategy,
    fingerprint: "",
  };
  return Object.freeze({
    ...command,
    fingerprint: fingerprintControllerCommand(command),
  });
}

function receipt(
  command: FrozenControllerCommand,
  outcome: ControllerReceipt["outcome"],
  extras: Partial<ControllerReceipt> = {},
): ControllerReceipt {
  return {
    outcome,
    reason: extras.reason ?? null,
    signaled: extras.signaled === true,
    spawned: extras.spawned === true,
    guardian: extras.guardian === true,
    operationId: command.operationId,
  };
}

function withStrategy(command: FrozenControllerCommand, strategy: LaunchStrategy): FrozenControllerCommand {
  const next = {
    intent: command.intent,
    confirmed: command.confirmed,
    operationId: command.operationId,
    boxRoot: command.boxRoot,
    strategy,
    fingerprint: "",
  };
  return Object.freeze({
    ...next,
    fingerprint: fingerprintControllerCommand(next),
  });
}

type ControlStore = {
  peek: (input: { operationId: string; boxRoot: string }) => Effect.Effect<OperationRecord | null, unknown>;
  settle: (input: {
    operationId: string;
    boxRoot: string;
    state: "running" | "unknown" | "terminal";
    prefix?: OperationPrefix;
  }) => Effect.Effect<void, unknown>;
};

function markUnknown(
  control: ControlStore,
  command: FrozenControllerCommand,
  prefix: OperationPrefix,
) {
  return control.settle({ operationId: command.operationId, boxRoot: command.boxRoot, state: "unknown", prefix });
}

function persistRunningPrefix(
  control: ControlStore,
  command: FrozenControllerCommand,
  progress: OperationPrefix,
) {
  return Effect.gen(function* () {
    const published = yield* Effect.result(control.settle({
      operationId: command.operationId,
      boxRoot: command.boxRoot,
      state: "running",
      prefix: progress,
    }));
    if (published._tag === "Failure") {
      yield* markUnknown(control, command, progress).pipe(Effect.ignore);
      return receipt(command, "recovery-required", { reason: "checkpoint-failed", ...progress });
    }
    return null;
  });
}

/** Unique controller program. Preview/reconcile never mutate; apply requires confirm + frozen command. */
export function runControllerOperation(request: ControllerRequest) {
  return Effect.gen(function* () {
    const control = yield* ControlResources;
    const admitted = admitControllerRequest(request);
    if (!admitted) {
      return {
        outcome: "refused" as const,
        reason: "invalid-intent",
        signaled: false,
        spawned: false,
        guardian: false,
        operationId: typeof request.operationId === "string" ? request.operationId : "",
      };
    }
    let command = admitted;
    if (command.intent === "apply" && command.confirmed !== true) {
      return receipt(command, "refused", { reason: "no-confirm" });
    }
    if (command.intent === "preview" || command.intent === "reconcile") {
      const existingResult = yield* Effect.result(control.peek({ operationId: command.operationId, boxRoot: command.boxRoot }));
      if (existingResult._tag === "Failure") {
        return receipt(command, "recovery-required", { reason: "store-corrupt" });
      }
      const existing = existingResult.success;
      const pre = yield* Effect.result(control.preflight(command));
      if (existing?.state === "unknown") {
        return receipt(command, "recovery-required", { reason: "uncertain-operation" });
      }
      if (existing?.state === "terminal" && existing.fingerprint === command.fingerprint) {
        return receipt(command, "converged");
      }
      if (pre._tag === "Failure" || !pre.success.ok) {
        return receipt(command, "recovery-required", { reason: pre._tag === "Failure" ? "preflight" : pre.success.reason });
      }
      return receipt(command, "preview", { reason: pre.success.reason });
    }

    const progress: OperationPrefix = { signaled: false, spawned: false, guardian: false };
    return yield* Effect.scoped(Effect.gen(function* () {
      if (command.strategy == null) {
        const pre = yield* Effect.result(control.preflight(command));
        if (pre._tag === "Failure" || !pre.success.ok) {
          return receipt(command, "refused", { reason: pre._tag === "Failure" ? "preflight" : pre.success.reason ?? "preflight" });
        }
        if (pre.success.strategy !== "direct" && pre.success.strategy !== "transient") {
          return receipt(command, "refused", { reason: "missing-strategy" });
        }
        command = withStrategy(command, pre.success.strategy);
      }

      const held = yield* Effect.result(control.lease(command));
      if (held._tag === "Failure") {
        return receipt(command, "refused", { reason: "lease-failed" });
      }
      if (held.success.status === "duplicate") {
        return receipt(command, "converged", { reason: "duplicate-operation" });
      }
      if (held.success.status === "busy") {
        return receipt(command, "refused", { reason: "operation-busy" });
      }
      if (held.success.status === "uncertain") {
        return receipt(command, "unknown", { reason: "uncertain-operation" });
      }
      if (held.success.status === "conflict") {
        return receipt(command, "refused", { reason: "operation-conflict" });
      }
      if (held.success.status === "corrupt") {
        return receipt(command, "recovery-required", { reason: "store-corrupt" });
      }

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const existing = yield* Effect.result(control.peek({
            operationId: command.operationId,
            boxRoot: command.boxRoot,
          }));
          if (existing._tag === "Success" && existing.success?.state === "running") {
            yield* markUnknown(control, command, progress);
          }
        }).pipe(Effect.ignore),
      );

      const pre = yield* Effect.result(control.preflight(command));
      if (pre._tag === "Failure" || !pre.success.ok) {
        return receipt(command, "refused", { reason: pre._tag === "Failure" ? "preflight" : pre.success.reason ?? "preflight" });
      }
      const again = yield* Effect.result(control.recheck(command));
      if (again._tag === "Failure" || !again.success.ok) {
        return receipt(command, "refused", { reason: again._tag === "Failure" ? "recheck" : again.success.reason ?? "recheck" });
      }

      if (command.strategy === "transient") {
        const spawnedResult = yield* Effect.result(control.spawn(command));
        if (spawnedResult._tag === "Failure") {
          yield* markUnknown(control, command, progress);
          return receipt(command, "partial", { reason: "spawn-failed", ...progress });
        }
        progress.spawned = spawnedResult.success.spawned === true;
        const spawnCheckpoint = yield* persistRunningPrefix(control, command, progress);
        if (spawnCheckpoint) return spawnCheckpoint;
        const armed = yield* Effect.result(control.armGuardian(command));
        if (armed._tag === "Failure") {
          yield* markUnknown(control, command, progress);
          return receipt(command, "partial", { reason: "guardian-failed", ...progress });
        }
        progress.guardian = armed.success.guardian === true;
        const guardianCheckpoint = yield* persistRunningPrefix(control, command, progress);
        if (guardianCheckpoint) return guardianCheckpoint;
      } else if (command.strategy === "direct") {
        const signaledResult = yield* Effect.result(control.signal(command));
        if (signaledResult._tag === "Failure") {
          yield* markUnknown(control, command, progress);
          return receipt(command, "partial", { reason: "signal-failed", ...progress });
        }
        progress.signaled = signaledResult.success.signaled === true;
        const signalCheckpoint = yield* persistRunningPrefix(control, command, progress);
        if (signalCheckpoint) return signalCheckpoint;
      } else {
        return receipt(command, "refused", { reason: "missing-strategy" });
      }

      const waited = yield* Effect.result(control.wait(command));
      if (waited._tag === "Failure") {
        yield* markUnknown(control, command, progress);
        return receipt(command, "unknown", { reason: "wait-failed", ...progress });
      }
      const committed = yield* Effect.result(control.commit(command));
      if (committed._tag === "Failure" || !committed.success.committed) {
        yield* markUnknown(control, command, progress);
        return receipt(command, "recovery-required", { reason: "commit-failed", ...progress });
      }
      yield* control.settle({ operationId: command.operationId, boxRoot: command.boxRoot, state: "terminal", prefix: progress });
      return receipt(command, "signaled", progress);
    })).pipe(Effect.catchCause((cause) => Effect.uninterruptible(Effect.gen(function* () {
      yield* markUnknown(control, command, progress).pipe(Effect.ignore);
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.failCause(cause);
      }
      return receipt(command, "unknown", {
        reason: Cause.hasDies(cause) ? "defect" : "fault",
        ...progress,
      });
    }))));
  });
}
