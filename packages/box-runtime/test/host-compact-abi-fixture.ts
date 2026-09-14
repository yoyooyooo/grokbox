/**
 * Compact ABI fixture for the native vs grokbox `handleSummarization` fork.
 *
 * Native Host (generation that added the field) treats `settledMessageCount` as
 * optional and switches `allMessages` to that prefix only when every guard below
 * holds. grokbox `compact.ts` currently uses `WaitForCompletion` +
 * `input_token_limit_error` and does not pass the field, so native rules leave
 * in-flight step output in the snapshot.
 *
 * Owned reconstruction of the documented ABI, not Host source and not
 * production enablement. Open product question: `host-compact-abi.md`.
 */

export type NativeSummarizationMode =
  | "Background"
  | "BackgroundAndPersistIfCompleted"
  | "WaitForCompletion"
  | "WaitForCompletionIfStarted";

export type NativeCompactSnapshotOptions = {
  backgroundSummarizationMode: NativeSummarizationMode;
  settledMessageCount?: number;
  fullSummarization?: boolean;
};

export type NativeCompactMessage = {
  role: string;
  content?: unknown;
};

/** Static fields grokbox `compact.ts` currently passes into `handleSummarization`. */
export const GROKBOX_HANDLE_SUMMARIZATION_STATIC = {
  backgroundSummarizationMode: "WaitForCompletion",
  forceExternalModel: true,
  triggerReason: "input_token_limit_error",
} as const;

/** Live seventh-argument keys from `requestHostCompact` → Host `handleSummarization`. */
export const GROKBOX_HANDLE_SUMMARIZATION_KEYS = [
  "backgroundSummarizationMode",
  "currentInvocationId",
  "forceExternalModel",
  "resourceAccessor",
  "triggerReason",
] as const;

/**
 * Native settled-prefix selection.
 * `settledSnapshotCacheSafe` is true for external summarizers (grokbox already
 * sends `forceExternalModel: true`) and a small set of self-summary flavors.
 */
export function nativeSettledSnapshotMessages(
  allMessages: readonly NativeCompactMessage[],
  options: NativeCompactSnapshotOptions,
  settledSnapshotCacheSafe = true,
): readonly NativeCompactMessage[] {
  if (
    options.backgroundSummarizationMode === "Background"
    && options.fullSummarization !== true
    && settledSnapshotCacheSafe
    && options.settledMessageCount !== undefined
    && options.settledMessageCount < allMessages.length
  ) {
    const candidate = allMessages.slice(0, options.settledMessageCount);
    if (candidate.some((message) => message.role === "system")) return candidate;
  }
  return allMessages;
}
