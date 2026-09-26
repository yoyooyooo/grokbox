# Current native evolution and pre-adoption qualification

Date: 2026-09-24. Integration base: `92e196d897ef9136d6a0d8b7842dd05c1cebd370`. Implementation commits: `0437b5318dd86c3f42631b39fe8e394e231a267b`, `0aa561d1a96076001faa6224d6f596ac441f852f`, and final code `37a23681beefa6af391ed219002b190daeda97f3`. AH-181 tracks current native pairing; AH-162 retains independent review and AH-122 candidate integration responsibilities. This report is not an adoption receipt.

## Independent review already closed

AH-180's original independent reviewer completed the exact three-file repair recheck and documentation-only successor comparison at `92e196d8`, returning Accepted for the receipt/candidate-binding finding. Linear was successfully updated to Done. This does not cover the new native changes below or constitute whole-candidate acceptance. The earlier blocked attempts remain unsuccessful historical attempts.

## Two observed native revisions, three distinct findings

The first observed pair was Host `89fd93fcb0b04d5a533ebedc833c8ca42e08612191ce008a2e6c257e09ce69cf` and worker `5fd47aaf6559205dc200ea9bc0593cdcf28b83664086f3305eedc9ce8d5f80aa`. The original source expectation rejected it. Read-only structural diagnosis independently found one of 39 LIVE recipe mismatches: a new `activeTurnOriginatingFlow` export appeared between `run` and `steer`. The context recipe unnecessarily included untouched neighboring fields in its replacement match.

The context repair replaces only the original return object's `run` property, retaining the function anchors and unique-match rule. Owned VM tests demonstrate original delegation, busy/cancellation closure, native aliases and a dynamic added accessor survive with and without the hook; absent/ambiguous matches still refuse. The original six manual-context queue/cancellation/unknown cases also pass. The production tuple and independent qualification pins were explicitly advanced only for the tested pair, retaining old and mixed-generation refusal. Complete native-runtime and core-risk then passed for that first pair; its later observation failures were not hidden.

During continued work, Host changed again to `eb4388069359a0101ac442d3b391def3c28e783161f4b6954ce50169f49e172c`; the worker stayed unchanged. This second revision is the final selected pair in this report. It buffers complete group message objects instead of only their text. The group-buffer recipe now preserves that original append exactly and adds only the guarded observation call. Three owned VM counterexamples failed before the repair and pass afterward, preserving the same object when observation is absent or throws; controlled DM and text-delta branches do not become buffered publication claims. The public shaped fixture follows the current object contract; no retired content-only production path was added.

Separately, the native message qualification fixture omitted the newly used `readCloudAgentPeerIds` dependency and its declared limit. VM errors had been reduced to `unknown` by a cross-realm `instanceof Error` test. Bounded identifier-only diagnostics exposed the missing helper. The fixture now extracts the original reader and numeric constant from the fixed source, and supplies controlled peer-roster statement rows as an explicit external capability. It does not replace the original transcript writer, SQL, association or cold-reopen reader. A new test verifies the native limit, rejection of non-string rows, peer metadata in the tail, and no RPC/transcript write. This was a fixture dependency omission, not an established production message-writer defect.

## Final same-source verification

All following native runs used final code `37a23681`, declared Bun 1.3.14, explicit native Node, the original complete inventories and original per-test/child deadlines. Every before/after source capture was:

`5304264c45f876eb83cb772b53ecdea57412078ebfc2da2843dc424907e2dad5` — 1,320 source objects.

The original source-set capture was `b7ea36913c338883865f4e0ad30276672cd73a6382f32a68c877459834f61b72`, binding the final Host/worker pair above. All windows remained stable and their end-of-window origin freshness was unchanged.

| Original verifier | Actual completed scope |
| --- | --- |
| `verify-host-health.mjs native-runtime` | 4/4 commands, 87 Bun tests passed; original selected summarizer, original AgentStore/worker SQLite transactions and independent process reader, modeld/SDK with owned upstream, context/compact/tool continuity |
| `verify-host-health.mjs core-risk` | 7/7 commands, 295 Bun tests passed; all required native/static/controlled risk groups, including receiver preview, checkpoint and non-target boundaries |
| `verify-host-health.mjs core-observation` | 10/10 commands, 231 Bun tests passed; includes 15 original-declaration Node message cases using owned SQLite, correlation, original request identity, default protection, notification authorization and bounded observation storage |
| Final package/context/group cross-check | 28 passed across four files; includes seven package tests with real disposable-prefix tarball installation and both Node CLI aliases |
| Build / types / boundaries / privacy | Full CLI/runtime/Web build, root and Web TypeScript, runtime boundary and publication checks passed |

All 21 native verifier commands returned code 0, error null, signal null and settled true. Counts are per suite and overlap; nested Node cases are included in outer wrappers and are not extra totals. Every verifier retains `qualified=false` and `passed-in-selected-scope`: full Host execution, actual loaded identity, real Provider/App behavior, boot ownership, restart and 24-hour operation remain unproven. The prior full offline core/integration result is retained in [the earlier candidate report](2026-09-24-core-candidate-101e77be.md); it is not represented as a fresh full offline run on this final source.

## Failures and limits retained

The initial hash mismatches, isolated shell recipe counterexamples, old worker guard refusals, receiver-pin failure and missing peer-reader failures remain part of the diagnosis, not discarded green attempts. The first observation attempt ended with SIGKILL; an unchanged retry produced the actionable message failure. No cause of that SIGKILL was established. The first final-source core-risk call returned a remote timeout without its final receipt, and its processes were subsequently observed ended. An unchanged full re-run through a read-only output summarizer returned all seven original receipts; only output size was reduced, not the test plan, assertions or limits.

A temporary DevSpace 502 interruption did not imply the Box or worktree had vanished: the existing SSH route supplied read-only Git state. A DevSpace status request was tool-blocked and no service restart occurred. Direct DevSpace access subsequently returned. No denied review or system-control call was retried through another channel.

The AH-181 independent review invocation was blocked before execution; no acceptance exists for the new native changes. The proposed separate second-evolution issue creation was also blocked before execution and no new issue identifier was obtained. Its prepared brief remains in the implementation worktree. Tested code may be integrated as a candidate, but AH-181/AH-162/AH-122 and J2 cannot be signed off by these tests.

AH-156 still lacks a qualified persistent service owner for this Box. Existing observation showed `tini` with an unavailable systemd user manager; this work neither installs a manager nor modifies init or the official supervisor. Operational authorization and model/token permission do not substitute for that platform qualification.

The user's new real-E2E model precedence and no-token-cap authorization were successfully recorded in AH-124 and AH-125. Existing operation identity, unknown reconciliation and resource/time bounds remain; unexecuted model/effort matrix cells remain unproven. No real Bot, Provider, desktop, credential, global shim or active Host/modeld was changed. No push, release, deployment or daily-use acceptance is implied.
