# Compact STEP deadline and frame EOF · 2026-09-24

Base: `d5c565c4df832c033f41f8f927e80d8e079e5a86`.
Final reviewed code: `5c01e52d6e2c0dc64cf46275e6ea56a2dff0c5ef`. This report is added afterward; it changes no runtime source.

## Reproduced behavior

The original modeld STEP used its injected monotonic Clock, but its same-connection
compact adapter created a separate performance-clock deadline. With a 170-second
initial claim, the real Unix control frame still granted about 175 seconds rather
than the remaining 5 seconds after the existing resume reserve. At 176 seconds it
still requested compact instead of refusing insufficient remaining budget.

Three additional reader cases showed that end/close/error did not independently
settle readOneFrame. Its parent STEP already had a disconnect race; this was not
proof that every real compact disconnect hung. A new real-peer EOF case verifies
STEP settlement, no second inference and complete resource cleanup.

An independent review of the first repair found EOF was checked before decoding
already-buffered complete frames. Two actual Unix EOF/closed-socket cases reproduced
that repair regression. The final version decodes buffered data first, while the
parent disconnect watcher separately cancels an already-ended peer. Reading bytes
never grants fresh STEP execution permission. Abort remains prior to decode.

## Original owners retained

The parsed STEP supplies one remainingMs callback to its compact Layer for both
admission and stream consumption. The adapter has no independent 180-second origin.
The existing 5-second reserve and total STEP limit are unchanged. No new executor,
writer or retry queue was introduced. Incomplete EOF settles promptly; all reader
listeners and adapter resume flags are released on normal completion or cancellation.

Overflow nonce reservation before Host effects is intentionally unchanged. Existing
concurrent/interrupted/unknown tests retain one compact invocation. The independent
context-maintenance channel requires that reservation and keeps its own native
operation owner; it is not silently given a STEP compact capability.

## Verification and independent review

Declared Bun 1.3.14, frozen lockfile. Eight new cases remain in the original compact
adapter suite, which is already consumed by existing verification entry points.

| Verification | Actual result |
| --- | --- |
| Compact adapter + original STEP deadline + overflow recovery | 32 pass, 0 fail |
| Fourteen-file cross-domain suite | 106 pass, 0 fail |
| Build, root/Web types, docs, runtime boundaries, publication | Passed |
| Independent repair source review | Accepted for AH-175 only |
| Original native-runtime runner, complete retry | Four commands, all code 0 and settled |

Counts overlap and are not added. Reviewer inspected fixed source and did not run
these tests or modify code. Source hashes from both review manifests were checked
against the final code before delivery.

The first native-runtime attempt completed three groups; its fourth child exited
with SIGKILL. That failure remains preserved. One complete retry changed neither
source, plan nor budgets and passed all four commands. Retry cgroup oom_kill was
116 before and after; that does not establish the first SIGKILL's cause.

Native verification before/after digest:
`3c041b787ddc6c26752647f11ea9611d77e50da8bfe0b7787b7412ebafb335b9` (1319 source/test/lock objects).
Native source window was stable and freshness unchanged; this is
passed-in-selected-scope with qualified=false, not live adoption.

## Limits and handoff

The unchanged oversized-resume branch was not dynamically tested: its additional
probe was blocked before execution. AH-176 separately owns that review question;
no duplication or false-success incident is asserted without evidence. This report
does not close the whole AH-162 review, AH-156 service platform qualification or J2.

Tests used owned files/sockets, synthetic inference capabilities and isolated native
source qualifications. No task was sent to a user Bot, and no deployed Host/modeld,
user credentials, desktop or global shim was changed. Raw validation and independent
review outputs remain in the feature tree under `.scratch/compact-review/`.
