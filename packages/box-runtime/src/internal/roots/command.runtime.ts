import { Cause, Effect, Exit } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { ConfigurationRead, type ControllerReceipt } from "@grokbox/runtime-kernel/ports";
import { assertRouteAssignment } from "@grokbox/runtime-kernel/selection";
import { projectLiveStatus, type RuntimeStatus } from "../io/observe.ts";
import { configurationReadLayer, type RuntimeStore } from "../io/configuration.node.ts";
import { saveRuntimeDesired } from "../io/configuration-write.node.ts";
import type { OwnershipReader } from "../io/ownership-admission.node.ts";
import { startModeldProcess, type StartedModeld } from "./modeld.runtime.ts";
import { startControlOperation, controllerOperationId } from "./controller-program.node.ts";

export type RuntimeStartMode = "observe" | "identity" | "route";
export type RuntimeStartResult = {
  process: "start";
  desired: RuntimeStartMode;
  configRevision: string;
  inject: false;
  reAdopt: false;
  takesEffect: "next_user_turn";
  productionAccepted: false;
  service: { lifetime: "foreground" | "borrowed"; autostartInstalled: false };
  modeld: StartedModeld["ensure"] & { ready: true };
  reconciliation: ControllerReceipt | null;
  status: RuntimeStatus;
};

export function parseRuntimeStartMode(mode: string | undefined): RuntimeStartMode {
  if (mode !== "observe" && mode !== "identity" && mode !== "route") {
    throw new BoxRuntimeError("invalid_usage", "runtime start --mode must be observe, identity, or route.");
  }
  return mode;
}

export function watchdogRequiredForStart(mode: RuntimeStartMode): boolean {
  return mode === "identity" || mode === "route";
}

export type RuntimeStartInput = {
  mode: RuntimeStartMode;
  signal: AbortSignal;
  validate: Effect.Effect<void, unknown>;
  /** Same production ensure/root as `modeld run`, including service-info root
   * qualification. The supplied signal also cancels acquisition before ready. */
  startModeld: (signal: AbortSignal) => Promise<StartedModeld>;
  activate: (mode: RuntimeStartMode) => Promise<{ configRevision: string }>;
  /** Must be the existing unconfirmed reconcile program, never apply/adopt. */
  reconcile?: () => Promise<ControllerReceipt>;
  status: () => Promise<RuntimeStatus>;
  publish: (receipt: RuntimeStartResult) => void;
};

/** One command Scope owns preparation, output and its newly created service.
 * A ready receipt is not process completion: an owned service stays foreground
 * until this command's signal; a borrower returns without stopping its owner.
 * Configuration saves are real commits, not undone on later output failure. */
export async function prepareRuntimeStart(input: RuntimeStartInput): Promise<RuntimeStartResult> {
  const mode = parseRuntimeStartMode(input.mode);
  if (watchdogRequiredForStart(mode) && !input.reconcile) {
    throw new BoxRuntimeError("invalid_usage", "runtime start requires unconfirmed reconciliation for identity/route.");
  }
  if (input.signal.aborted) throw new BoxRuntimeError("invalid_usage", "runtime_start_cancelled");
  let published: RuntimeStartResult | undefined;
  const program = Effect.gen(function* () {
    yield* input.validate;
    return yield* Effect.acquireUseRelease(
      // acquireUseRelease masks acquisition interruption until cleanup ownership
      // is registered. The command signal still reaches the startup root, so an
      // aborted/failed acquire settles only after its own resources close.
      Effect.tryPromise({ try: () => input.startModeld(input.signal), catch: error => error }),
      started => Effect.gen(function* () {
        // Do not leave a detached file write on cancellation. Finish the single
        // canonical write, then honour interruption; no pretend multi-file rollback.
        const saved = yield* Effect.uninterruptible(Effect.tryPromise({
          try: () => input.activate(mode), catch: error => error,
        }));
        const reconciliation = watchdogRequiredForStart(mode)
          ? yield* Effect.uninterruptible(Effect.tryPromise({ try: () => input.reconcile!(), catch: error => error }))
          : null;
        const status = yield* Effect.tryPromise({ try: () => input.status(), catch: error => error });
        const receipt: RuntimeStartResult = {
          process: "start", desired: mode, configRevision: saved.configRevision,
          inject: false, reAdopt: false, takesEffect: "next_user_turn", productionAccepted: false,
          service: { lifetime: started.ensure.kind === "owned" ? "foreground" : "borrowed", autostartInstalled: false },
          modeld: { ...started.ensure, ready: true }, reconciliation, status,
        };
        yield* Effect.sync(() => { input.publish(receipt); published = receipt; });
        if (started.ensure.kind === "owned") {
          yield* Effect.tryPromise({ try: () => started.finished, catch: error => error });
          if (!input.signal.aborted) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_stopped_unexpectedly"));
        }
        return receipt;
      }),
      started => started.ensure.kind === "borrowed" ? Effect.void : Effect.tryPromise({
        try: () => started.stop(),
        catch: () => new BoxRuntimeError("invalid_usage", "cleanup_gap"),
      }),
    );
  });
  const exit = await Effect.runPromiseExit(program, { signal: input.signal });
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    if (published) return published;
    throw new BoxRuntimeError("invalid_usage", "runtime_start_cancelled");
  }
  // A shutdown failure is not successful SIGTERM and must not be hidden by an
  // earlier output/configuration error or by the lack of optional counters.
  for (const reason of exit.cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof BoxRuntimeError && reason.error.message === "cleanup_gap") {
      throw reason.error;
    }
  }
  throw Cause.squash(exit.cause);
}

/** Live composition used by CLI and future callers, not a second daemon.
 * Read-only profile/attestation checks remain in the existing controller and
 * status owners; this entry never supplies confirmed apply/adopt authority. */
export function startRuntimeCommand(input: {
  store: RuntimeStore; runRoot: string; mode: string | undefined; signal: AbortSignal;
  env?: NodeJS.Dict<string>; ownershipRead?: OwnershipReader;
  publish: (receipt: RuntimeStartResult) => void;
}): Promise<RuntimeStartResult> {
  const mode = parseRuntimeStartMode(input.mode);
  const validate = mode === "route" ? Effect.gen(function* () {
    const config = yield* ConfigurationRead;
    const snapshot = yield* config.snapshot();
    yield* Effect.sync(() => assertRouteAssignment(snapshot.models));
  }).pipe(Effect.provide(configurationReadLayer(input.store))) : Effect.void;
  return prepareRuntimeStart({ mode, signal: input.signal, validate,
    startModeld: signal => startModeldProcess({ durableRoot: input.store.root,
      runRoot: input.runRoot, env: input.env, ownershipRead: input.ownershipRead, signal }),
    activate: next => saveRuntimeDesired(input.store, { version: 1, mode: next }),
    reconcile: () => startControlOperation({ intent: "reconcile", confirmed: false,
      operationId: controllerOperationId("reconcile", input.store.root), boxRoot: input.store.root }),
    status: () => projectLiveStatus({ root: input.store.root, ephemeralRoot: input.runRoot }),
    publish: input.publish,
  });
}
