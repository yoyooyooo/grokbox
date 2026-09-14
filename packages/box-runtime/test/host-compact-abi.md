# Compact ABI — `settledMessageCount` / `WaitForCompletion`

Decision input only. This fixture is **not** HostCompact production enablement
and does **not** authorize changing `compact.ts`. Production stays fail-closed
(`GROKBOX_MODELD_HOST_COMPACT` exact `1` only) until a product answer plus
journaled overflow → compact-request → resume evidence exists for the current
Host generation.

## Observed fork

Native `handleSummarization` treats `settledMessageCount` as optional. It
switches the snapshot to that prefix only when **all** of these hold:

- `backgroundSummarizationMode === "Background"`
- `fullSummarization !== true`
- snapshot cache is considered safe (external summarizer, which grokbox already
  forces, or a small set of self-summary flavors)
- the field is present (`!== undefined`)
- count is strictly less than `allMessages.length`
- the prefix still contains a system message

Native `WaitForCompletion` (the input-token-limit path grokbox copies) does not
pass the field and **does not slice even if the field is present**.

grokbox `compact.ts` currently calls:

- `backgroundSummarizationMode: "WaitForCompletion"`
- `triggerReason: "input_token_limit_error"`
- `forceExternalModel: true`
- no `settledMessageCount`

Under native rules that means in-flight step output can remain in the compact
snapshot.

## Open product question

Pick one. Unanswered means do not change `compact.ts` and do not treat any
HostCompact path as production-ready:

1. Pass `settledMessageCount` **and** switch to `Background` so overflow compact
   excludes the still-streaming step. Passing the field while staying on
   `WaitForCompletion` is a no-op under native rules.
2. Switch to `Background` without the field (also a no-op: optional field absent
   → no slice).
3. Keep `WaitForCompletion` and accept that in-flight step output may enter the
   compact snapshot.

See `host-compact-abi-fixture.ts` and `host-compact-abi.test.ts`.
