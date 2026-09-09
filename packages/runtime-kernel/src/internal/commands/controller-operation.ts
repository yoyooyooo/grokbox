import { Effect } from "effect";
import { canonicalJson, sha256Text } from "../../hash.ts";
import {
  ControlResources,
  type ControllerReceipt,
  type ControllerRequest,
  type FrozenControllerCommand,
  type LaunchStrategy,
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

function markUnknown(
  control: { settle: (input: { operationId: string; boxRoot: string; state: "unknown" | "terminal" }) => Effect.Effect<void, unknown> },
  command: FrozenControllerCommand,
) {
  return control.settle({ operationId: command.operationId, boxRoot: command.boxRoot, state: "unknown" });
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
      const existing = yield* control.peek({ operationId: command.operationId, boxRoot: command.boxRoot });
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

    const progress = { signaled: false, spawned: false, guardian: false };
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
        progress.spawned = true;
        if (spawnedResult._tag === "Failure") {
          yield* markUnknown(control, command);
          return receipt(command, "partial", { reason: "spawn-failed", ...progress });
        }
        progress.spawned = spawnedResult.success.spawned;
        const armed = yield* Effect.result(control.armGuardian(command));
        progress.guardian = true;
        if (armed._tag === "Failure") {
          yield* markUnknown(control, command);
          return receipt(command, "partial", { reason: "guardian-failed", ...progress });
        }
        progress.guardian = armed.success.guardian;
      } else if (command.strategy === "direct") {
        const signaledResult = yield* Effect.result(control.signal(command));
        progress.signaled = true;
        if (signaledResult._tag === "Failure") {
          yield* markUnknown(control, command);
          return receipt(command, "partial", { reason: "signal-failed", ...progress });
        }
        progress.signaled = signaledResult.success.signaled;
      } else {
        return receipt(command, "refused", { reason: "missing-strategy" });
      }

      const waited = yield* Effect.result(control.wait(command));
      if (waited._tag === "Failure") {
        yield* markUnknown(control, command);
        return receipt(command, "unknown", { reason: "wait-failed", ...progress });
      }
      const committed = yield* Effect.result(control.commit(command));
      if (committed._tag === "Failure" || !committed.success.committed) {
        yield* markUnknown(control, command);
        return receipt(command, "recovery-required", { reason: "commit-failed", ...progress });
      }
      yield* control.settle({ operationId: command.operationId, boxRoot: command.boxRoot, state: "terminal" });
      return receipt(command, "signaled", progress);
    })).pipe(Effect.catchCause(() => Effect.gen(function* () {
      yield* markUnknown(control, command).pipe(Effect.ignore);
      return receipt(command, "unknown", { reason: "interrupted", ...progress });
    })));
  });
}
