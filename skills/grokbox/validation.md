# Model-switch acceptance

Load only for an explicitly requested canary or sustained model-switch check: `grokbox skills get grokbox --topic validation`. Routine model selection uses [models](models.md); ordinary reply checks use [send](send.md). This is not a startup test or permission to keep monitoring.

## Prove a model switch

Use a separately authorized test Bot, never the operator/template Bot. `model-dogfood` below is an example dedicated long-lived validation Bot, not an instruction to create or reuse a production Bot. For ordinary experiments, create a disposable Bot and substitute its exact ID. Verify `confirmed_box` ownership first.

A send receipt or an immediate title paint is not enough: the App name must still show the model after a title refresh.

```bash
grokbox models use <model-id> --for model-dogfood
grokbox send model-dogfood --text "<text>" --json
# Keep data.clientNonce. data.accepted / data.status=accepted means queued, not a reply.

grokbox history outcome model-dogfood --nonce <clientNonce> --runtime --wait-ms 60000 --json
grokbox agents show model-dogfood --json
# data.agent.title (App Label) must include m=<alias-or-model>.

grokbox agents title sync model-dogfood
# For scheduled-refresh acceptance, observe a completed daemon refresh before reading again.
grokbox agents show model-dogfood --json
```

An explicit sync and readback checks the selected Bot. Scheduled-refresh acceptance additionally needs a running title service and evidence that its refresh completed; elapsed time alone proves neither. Scope the explicit sync to the validation Bot. The second read must still show `m=<alias-or-model>`.

Read outcome using the [send state table](send.md#read-the-outcome-not-just-the-receipt). Do not claim success on `recorded`, empty alerts, runtime gaps, or a title that looked right only in the first second.

| Evidence | Honest result |
| --- | --- |
| Outcome delivered / expected, and `m=` stayed after the wait | “There's a reply, and the name still shows the selected model after refresh.” |
| Outcome `failed` / `unknown` | Report the failure or uncertainty; do not claim the switch worked. |
| `m=` disappears after refresh | Report a title-refresh failure; do not call this acceptance successful. |

This proves the observed reply/title checks, **not** provider identity, whole-run completion, native state continuity, or a production release. Stop after this bounded check and report remaining gaps. Do not start indefinite “stay-green” polling.
