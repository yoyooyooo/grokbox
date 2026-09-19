import { ContextFailure, CONTEXT_MATERIAL_MAX_BYTES, measureContext, parseContextMaterial,
  type ContextCandidate, type ContextCommitReceipt, type ContextMaterial, type ContextMaintenanceIdentity } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { cloneHostExecutorWindow, hostStateToMessages, hostToolsToCanonical } from "./context-codec.ts";

type Native = Record<string, unknown>;
const object = (value: unknown): value is Native => value !== null && typeof value === "object";
const invoke = (target: Native, key: string, ...args: unknown[]): unknown => {
  const fn = Reflect.get(target, key, target);
  if (typeof fn !== "function") throw new ContextFailure("capability_unqualified");
  return Reflect.apply(fn, target, args);
};
export type NativeContextCapture = {
  orchestrator: Native; ctx: Native; stateHandler: Native; rootPromptExecutor: Native;
  interactionListener: unknown; config: Native; requestContext: unknown; resourceAccessor: unknown;
  invocationId?: string; turnId: string; agentId: string; sessionId: string; modelId: string;
  normalize: (messages: unknown[]) => unknown[];
  fixedMessages: () => unknown[];
  tools: () => unknown;
  checkpoint: () => Promise<unknown>;
  activity?: (active: boolean, failed: boolean) => Promise<unknown>;
  valid: () => boolean;
  observe?: (event: { state: "checkpoint_started" | "checkpoint_observed" | "commit_unknown"; operationId: string;
    rootId: string; sourceRootRevision: string; rootRevision: string; persisted: boolean }) => Promise<void>;
};
export type NativeContextOwner = ReturnType<typeof createNativeContextOwner>;
const MARKER = "grokboxContextMaintenance";
function deferred<A>() {
  let resolve!: (value: A) => void, reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Native writer facade. No SDK, Effect, Pi runtime, file writes or second store.
 * Native summarizer methods build the real carrier/enrichments; native
 * handleSummarization archives/accepts it, followed by its real checkpoint owner. */
export function createNativeContextOwner(capture: NativeContextCapture) {
  const root = capture.rootPromptExecutor;
  const rootId = sha256Text(canonicalJson([capture.agentId, capture.sessionId]));
  let closed = false, committing = false, publicationStarted = false, published = false, persisted = false, activityStarted = false;
  let originalRaw: unknown[] | undefined, original: ContextMaterial | undefined;
  let proposed: ContextMaterial | undefined, proposedRaw: unknown[] | undefined;
  let operation: string | undefined, candidateFingerprint: string | undefined;
  let nativeWork: Promise<unknown> | undefined;
  let checkpointWork: Promise<unknown> | undefined;
  const pendingCommits = new Set<Promise<unknown>>();
  let pendingReady: ReturnType<typeof deferred<ContextMaterial>> | undefined;
  const child = typeof capture.ctx.withCancel === "function" ? invoke(capture.ctx, "withCancel") : undefined;
  const nativeCtx = Array.isArray(child) && object(child[0]) ? child[0] : capture.ctx;
  const cancelNative = Array.isArray(child) && typeof child[1] === "function" ? child[1] as (error?: unknown) => void : () => undefined;
  let release: ReturnType<typeof deferred<void>> | undefined;
  let nativePending: unknown;
  const signal = object(capture.ctx.signal) ? capture.ctx.signal as unknown as AbortSignal : undefined;
  const assertLive = () => {
    if (closed || !capture.valid() || signal?.aborted || object(nativeCtx.signal) && nativeCtx.signal.aborted === true) throw new ContextFailure("cancelled");
    if (capture.invocationId !== undefined && capture.stateHandler.lastStepInvocationId !== undefined && capture.stateHandler.lastStepInvocationId !== capture.invocationId) throw new ContextFailure("stale_root");
  };
  const rawMessages = (): unknown[] => {
    const value = invoke(root, "getMessages");
    if (!Array.isArray(value)) throw new ContextFailure("capability_unqualified");
    return value;
  };
  const plainMessages = (messages: unknown[]) => {
    if (messages.length > 65536) throw new ContextFailure("context_material_too_large");
    const plain = capture.normalize(messages);
    if (!Array.isArray(plain) || plain.length !== messages.length) throw new ContextFailure("context_material_invalid");
    return plain.map(message => cloneHostExecutorWindow([message])[0]!);
  };
  const rootRevision = (messages: unknown[]) => {
    const encoded = canonicalJson(plainMessages(messages));
    if (encoded.length > CONTEXT_MATERIAL_MAX_BYTES || new TextEncoder().encode(encoded).length > CONTEXT_MATERIAL_MAX_BYTES) throw new ContextFailure("context_material_too_large");
    return sha256Text(encoded);
  };
  const material = (raw: unknown[], retained?: string[], summaryRef?: string): ContextMaterial => {
    const plain = plainMessages(raw);
    const counts = new Map<string, number>();
    // getMessages() may return fresh clones on each call. Protect fixed native
    // content by value, not by object identity from a different read.
    const fixed = new Set(plainMessages(capture.fixedMessages()).map(message => canonicalJson(message)));
    let nextKept = 0;
    const rows = plain.map((message, index) => {
      const metadata = message.providerOptions;
      const summary = message.isSummary === true || object(metadata?.cursor) && metadata.cursor.isSummary === true;
      const marker = object(metadata?.[MARKER]) ? metadata[MARKER] as Native : undefined;
      let ref: string;
      if (marker?.operationId === operation && summaryRef) ref = summaryRef;
      else if (retained) {
        ref = retained[nextKept++]!;
        const expected = original?.messages.find(row => row.ref === ref);
        if (!expected || canonicalJson(hostStateToMessages([message])[0]) !== canonicalJson(expected.message)) throw new ContextFailure("context_material_invalid");
        // Unknown native metadata must also be identical, not only the prompt projection.
        const beforeIndex = original!.messages.findIndex(row => row.ref === ref);
        if (canonicalJson(message) !== canonicalJson(plainMessages([originalRaw![beforeIndex]])[0])) throw new ContextFailure("context_material_invalid");
      } else {
        const hash = sha256Text(canonicalJson(message));
        const ordinal = counts.get(hash) ?? 0; counts.set(hash, ordinal + 1);
        ref = `${hash}:${ordinal}`;
      }
      const prior = retained ? original!.messages.find(row => row.ref === ref) : undefined;
      const preserve = prior?.preserve ?? fixed.has(canonicalJson(message));
      return { ref, message: hostStateToMessages([message])[0]!, ...(preserve ? { preserve: true } : {}), ...(summary ? { summary: true } : {}) };
    });
    if (retained && nextKept !== retained.length) throw new ContextFailure("context_material_invalid");
    return parseContextMaterial({ rootId, rootRevision: rootRevision(raw), messages: rows, tools: hostToolsToCanonical(capture.tools()), options: {} });
  };
  const inspect = () => {
    assertLive();
    const raw = rawMessages();
    if (!original) { originalRaw = [...raw]; original = material(originalRaw); }
    if (!published && rootRevision(raw) !== original.rootRevision) throw new ContextFailure("stale_root");
    return original;
  };
  const checkCandidate = (candidate: ContextCandidate) => {
    assertLive();
    const current = inspect();
    if (candidate.sourceRootRevision !== current.rootRevision || !candidate.summary.trim()
      || candidate.summary.length > 128 * 1024 || !Array.isArray(candidate.retainedRefs) || !Array.isArray(candidate.summarizedRefs)) throw new ContextFailure("stale_root");
    const all = [...candidate.retainedRefs, ...candidate.summarizedRefs];
    if (all.length !== current.messages.length || new Set(all).size !== all.length
      || all.some(ref => !current.messages.some(row => row.ref === ref))) throw new ContextFailure("context_material_invalid");
    const keep = new Set(candidate.retainedRefs);
    if (canonicalJson(current.messages.filter(row => keep.has(row.ref)).map(row => row.ref)) !== canonicalJson(candidate.retainedRefs)
      || current.messages.some(row => row.preserve && !keep.has(row.ref))) throw new ContextFailure("context_material_invalid");
    return current;
  };
  const settleOldPending = async () => {
    const pending = capture.stateHandler.backgroundSummarizationPromiseInfo;
    if (pending == null) return;
    if (!object(pending) || !(pending.promise instanceof Promise)) throw new ContextFailure("maintenance_busy");
    if (capture.invocationId !== undefined && pending.startInvocationId === capture.invocationId) throw new ContextFailure("maintenance_busy");
    const token = capture.stateHandler.backgroundSummarizationCancellationToken;
    if (!object(token)) throw new ContextFailure("maintenance_busy");
    token.cancelled = true;
    if (typeof token.onCancelled === "function") Reflect.apply(token.onCancelled, token, []);
    // The request owner supplies the outer deadline. Do not erase an unresolved source.
    await pending.promise.catch(() => undefined);
    assertLive();
    if (capture.stateHandler.backgroundSummarizationPromiseInfo === pending) invoke(capture.stateHandler, "clearBackgroundSummarizationState");
  };
  const preview = async (candidate: ContextCandidate): Promise<ContextMaterial> => {
    const source = checkCandidate(candidate);
    const fingerprint = sha256Text(canonicalJson(candidate));
    if (operation && (operation !== candidate.operationId || candidateFingerprint !== fingerprint)) throw new ContextFailure("maintenance_conflict");
    if (proposed) return proposed;
    operation = candidate.operationId; candidateFingerprint = fingerprint;
    await settleOldPending(); assertLive();
    const ready = deferred<ContextMaterial>(); pendingReady = ready; release = deferred<void>();
    const raw = originalRaw!;
    const keep = new Set(candidate.retainedRefs), summarize = new Set(candidate.summarizedRefs);
    const summed = raw.filter((_row, index) => summarize.has(source.messages[index]!.ref));
    const tail = raw.filter((_row, index) => keep.has(source.messages[index]!.ref));
    const assertCurrent = () => {
      assertLive();
      if (!published && rootRevision(rawMessages()) !== source.rootRevision) throw new ContextFailure("stale_root");
    };
    const orchestrator = new Proxy(capture.orchestrator, {
      get(target, key) {
        if (key !== "getSummarizer") return Reflect.get(target, key, target);
        return (...args: unknown[]) => {
          const native = invoke(target, "getSummarizer", ...args);
          if (!object(native)) throw new ContextFailure("capability_unqualified");
          for (const method of ["summarize", "partitionMessages", "generateSummary", "assembleFinalMessages", "buildSummaryMessage"]) {
            if (typeof native[method] !== "function") throw new ContextFailure("capability_unqualified");
          }
          const facade = Object.create(native) as Native;
          facade.getMetricsModelLabel = () => capture.modelId;
          facade.partitionMessages = (messages: unknown[], options: unknown) => {
            const partition = invoke(native, "partitionMessages", messages, options);
            if (!object(partition)) throw new ContextFailure("capability_unqualified");
            return { ...partition, messagesToSummarize: summed, preservedTailMessages: tail.filter(row => object(row) && row.role !== "system") };
          };
          facade.generateSummary = async () => ({ text: candidate.summary, hadError: false });
          facade.assembleFinalMessages = (_partition: unknown, summaryMessage: unknown) => {
            if (!object(summaryMessage)) throw new ContextFailure("summary_invalid");
            const existing = object(summaryMessage.providerOptions) ? summaryMessage.providerOptions : {};
            summaryMessage.providerOptions = { ...existing, [MARKER]: { operationId: operation, sourceRootRevision: source.rootRevision,
              policyRevision: candidate.budget.policyRevision } };
            const result: unknown[] = []; let inserted = false;
            for (let i = 0; i < raw.length; i++) {
              if (summarize.has(source.messages[i]!.ref)) { if (!inserted) { result.push(summaryMessage); inserted = true; } }
              else result.push(raw[i]);
            }
            if (!inserted) throw new ContextFailure("no_improvement");
            return result;
          };
          facade.summarize = async (...summaryArgs: unknown[]) => {
            const result = await Reflect.apply(native.summarize as Function, facade, summaryArgs) as Native;
            assertCurrent();
            if (!object(result) || result.hadError === true || !Array.isArray(result.fullReplacementMessages)) throw new ContextFailure("summary_invalid");
            proposedRaw = result.fullReplacementMessages;
            proposed = material(proposedRaw, candidate.retainedRefs, `summary:${operation}`);
            if (measureContext(proposed).tokens > candidate.budget.resumeThresholdTokens) throw new ContextFailure("context_target_unreachable");
            ready.resolve(proposed);
            await release!.promise; assertCurrent();
            return result;
          };
          return facade;
        };
      },
    });
    // Delay the actual clear until the native replacement is supplied and checked.
    // A named-self-document refresh that changes the validated candidate refuses
    // before clearing the root, not after destructive publication.
    let clearRequested = false;
    const nativeRoot = new Proxy(root, {
      get(target, key) {
        if (key === "clearMessages") return () => { assertCurrent(); if (!committing) throw new ContextFailure("not_admitted"); clearRequested = true; };
        if (key === "appendMessages") return (messages: unknown[]) => {
          assertCurrent();
          if (!committing || !Array.isArray(messages)) throw new ContextFailure("not_admitted");
          if (!published) {
            if (!clearRequested || !proposed || rootRevision(messages) !== proposed.rootRevision) throw new ContextFailure("stale_root");
            // Native mutations are not a transaction. From the first call on,
            // an exception may follow a partial write even before append returns.
            publicationStarted = true;
            invoke(target, "clearMessages"); invoke(target, "appendMessages", messages); published = true;
          } else if (messages.length !== 0) throw new ContextFailure("stale_root");
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? (...args: unknown[]) => { assertLive(); return Reflect.apply(value, target, args); } : value;
      },
    });
    const nativeState = new Proxy(capture.stateHandler, {
      get(target, key) {
        assertLive(); const value = Reflect.get(target, key, target);
        return typeof value === "function" ? (...args: unknown[]) => {
          assertLive();
          if (key === "setBackgroundSummarizationState") nativePending = args[0];
          return Reflect.apply(value, target, args);
        } : value;
      },
      set(target, key, value) {
        assertLive();
        if (key === "backgroundSummarizationPromiseInfo" && value != null) nativePending = value;
        return Reflect.set(target, key, value, target);
      },
      defineProperty(target, key, descriptor) { assertLive(); return Reflect.defineProperty(target, key, descriptor); },
      deleteProperty(target, key) { assertLive(); return Reflect.deleteProperty(target, key); },

    });
    nativeWork = Promise.resolve(Reflect.apply(capture.orchestrator.handleSummarization as Function, orchestrator, [nativeCtx, nativeState, nativeRoot,
      capture.interactionListener, capture.config, capture.requestContext, { backgroundSummarizationMode: "WaitForCompletion", forceExternalModel: true,
        triggerReason: "force_option", currentInvocationId: capture.invocationId, resourceAccessor: capture.resourceAccessor }]))
      .catch(error => { ready.reject(error); throw error; });
    void nativeWork.catch(() => undefined);
    const result = await ready.promise;
    nativePending = capture.stateHandler.backgroundSummarizationPromiseInfo;
    return result;
  };
  const observeCommit = async (state: "checkpoint_started" | "checkpoint_observed" | "commit_unknown") => {
    if (!operation || !original || !proposed || !capture.observe) return;
    try { await capture.observe({ state, operationId: operation, rootId, sourceRootRevision: original.rootRevision,
      rootRevision: proposed.rootRevision, persisted: state === "checkpoint_observed" }); }
    catch { /* A diagnostic sink does not decide whether a native commit happened. */ }
  };
  const commitCandidate = async (candidate: ContextCandidate): Promise<ContextCommitReceipt> => {
    assertLive();
    if (!proposed || operation !== candidate.operationId || candidateFingerprint !== sha256Text(canonicalJson(candidate)) || !release || !nativeWork) throw new ContextFailure("not_admitted");
    if (!committing) {
      checkCandidate(candidate); committing = true;
      try {
        await observeCommit("checkpoint_started");
        // Diagnostic I/O is not an authorization lease. The root or cancellation
        // state can change while recording the intent, so check at consumption.
        checkCandidate(candidate);
        release.resolve();
        await nativeWork; assertLive();
        if (!published || rootRevision(rawMessages()) !== proposed.rootRevision) throw new ContextFailure("commit_unknown");
        checkpointWork = Promise.resolve().then(() => { assertLive(); return capture.checkpoint(); });
        await checkpointWork; assertLive();
        if (rootRevision(rawMessages()) !== proposed.rootRevision) throw new ContextFailure("commit_unknown");
        persisted = true;
        await observeCommit("checkpoint_observed");
      } catch (error) {
        // Preserve publication uncertainty across the Host/client/wire facade.
        // A raw checkpoint or append error must not become invalid input, nor
        // imply the old root survived or that this operation can be replayed.
        if (publicationStarted) { await observeCommit("commit_unknown"); throw new ContextFailure("commit_unknown"); }
        throw error;
      }
    }
    return { operationId: operation!, sourceRootRevision: original!.rootRevision, rootRevision: proposed.rootRevision,
      outcome: persisted ? "committed" : "commit_unknown", persisted, material: proposed };
  };
  const readCommit = (): ContextCommitReceipt | undefined => {
    assertLive();
    if (!operation || !original || !proposed || !published) return undefined;
    if (rootRevision(rawMessages()) !== proposed.rootRevision) throw new ContextFailure("stale_root");
    return { operationId: operation, sourceRootRevision: original.rootRevision, rootRevision: proposed.rootRevision,
      outcome: persisted ? "committed" : "commit_unknown", persisted, material: proposed };
  };
  const cancel = () => {
    if (closed) return;
    closed = true;
    const error = new ContextFailure("cancelled");
    release?.reject(error); pendingReady?.reject(error); cancelNative(error);
  };
  const startActivity = async () => {
    assertLive();
    if (activityStarted || !capture.activity) return;
    activityStarted = true;
    await capture.activity(true, false);
    assertLive();
  };
  const close = async () => {
    cancel();
    if (activityStarted && capture.activity) {
      activityStarted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([capture.activity(false, !persisted).catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    const pending = [nativeWork, checkpointWork, ...pendingCommits].filter((work): work is Promise<unknown> => work !== undefined);
    if (pending.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The checkpoint can outlive an aborted socket. Settling only the
        // summarizer would release the native owner while its write is pending.
        await Promise.race([Promise.allSettled(pending), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ContextFailure("native_cleanup_unknown")), 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    if (nativePending && capture.stateHandler.backgroundSummarizationPromiseInfo === nativePending) {
      invoke(capture.stateHandler, "clearBackgroundSummarizationState");
    }
  };
  const commit = (candidate: ContextCandidate): Promise<ContextCommitReceipt> => {
    const work = commitCandidate(candidate);
    pendingCommits.add(work);
    void work.then(() => pendingCommits.delete(work), () => pendingCommits.delete(work));
    return work;
  };
  return { rootId, inspect, preview, commit, readCommit, startActivity,
    hasPublicationStarted: () => publicationStarted,
    authorize: () => { assertLive(); return true; }, cancel, close };
}
