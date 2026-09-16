# Send and observe a reply

Load before sending or checking a send: `grokbox skills get grokbox --topic send`.

## Send once, keep the handle

`<agent>` is an exact ID or a unique name. A send creates a Human message; an observation does not send another one.

```bash
grokbox send <agent> --text "<text>" --json
# Keep data.clientNonce. data.accepted / data.status=accepted means queued, not a reply.

grokbox history outcome <agent> --nonce <clientNonce> --runtime --wait-ms 60000 --json
```

The example uses box-local runtime evidence for a box Bot. `--runtime` reads the local journal (failure authority), requires the box transcript route, and refuses remote Profiles. For an official temporal Bot or a remote Profile, omit `--runtime` and report that no local-runtime proof was obtained; do not change the Bot's harness just to make this check pass.

For sensitive or multiline text, supply the prompt on stdin instead of argv. `--text` suppresses stdin reads. There is no `send --wait`; observation belongs to `history outcome`.

## Read the outcome, not just the receipt

Read `data.state` together with `assessment` and `evidence`. Outcome has no `accepted` token (`acceptedObserved` is gone). Empty `data.alerts` is not success, and a null `data.requestId` on an early failure does not mean “never sent”.

| `data.state` | What is proved | What to report |
| --- | --- | --- |
| `recorded` | Echo or journal bind only; not a settled reply | “Queued; still waiting for a reply.” |
| `failed` | Correlated failure; empty alerts do not undo it | “The Bot couldn't reply.” Paraphrase `runtimeFailure.message` when present. |
| `progress` | A message appeared, but the expected text did not | “There's an update, but not the expected result yet.” |
| `delivered` | A same-request reply is on the transcript | “There's a reply.” Not “all work finished”. |
| `expected_result_observed` | Exact `--expect-text` appeared | “Got the expected result.” Execution completion is still not proved. |
| `unknown` | Missing or conflicting evidence | “Can't tell from this check.” |

`--wait-ms` is bounded (0..120000; default 0). Normal delivery waiting stops on `failed`, `delivered`, or `expected_result_observed`; `recorded` is not settled. When the budget ends, report the observed state instead of silently starting endless polls.

`executionCompleted` stays `not_proven`. A reply, expected text, title, or spinner is not whole-run completion. For execution-oriented diagnosis, read [diagnostics](diagnostics.md) rather than inferring that background work ended.

## Recheck without replay

Query again with the same `clientNonce`. `--request-id` is an alternative lookup for the **same send**, not a second handle. There is no `alerts list --nonce`.

Only an authorized retry may resend, using the same `--nonce` and the same target/prompt. Neither an unknown outcome nor runtime lineage evidence authorizes a retry. Unclear runtime evidence or an error banner's STEP: load [diagnostics](diagnostics.md) with `--topic diagnostics`.
