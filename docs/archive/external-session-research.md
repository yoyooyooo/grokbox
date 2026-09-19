# External PromptSession research — historical reference

The original study inspected `BlockedPath/grok-bot-setup` at `d9119f9632c635473213c57ace336028f7278abd` (commit dated 2026-08-17; inspected 2026-09-05). Its source set was GUIDE_CUSTOM_INFERENCE, GROK_BOT_CLAUDE_FIXES, xai-prompt-session and the associated installation script. This is bounded reference evidence, not a fresh upstream check or grokbox's current implementation authority.

## Lessons retained

A model adapter is narrower than an Agent runtime. The native Host keeps queue/loop, tools/permissions, root, Transcript, Memory and delivery. A session must present the exact native accessors and synchronous stream-result handle; asynchronous generation belongs behind its iterable/promises. The external implementation's three-argument function did not consume the guide's fourth options argument, so copying it would lose a contract rather than prove compatibility.

Independent completion observers must not dequeue the UI's stream. Response model identity, message arrays, usage shape and tool IDs are functional native inputs, not optional display metadata. IDs and arguments must remain correlated across streamed calls, complete response messages and later tool results. Native content blocks and tool schemas require explicit provider-boundary conversion; silent filtering and fabricated defaults are not compatibility.

The pinned example buffered parts before yielding, invented some zero usage defaults and applied provider-specific continuation behavior. Those are observations of that example, not policies to transplant. grokbox's actual streaming, unknown usage, qualified history normalization and bounded diagnostics are owned by [execution](../runtime/execution.md) and [provider compatibility](../maintainers/chat-provider-compatibility.md).

The external installer wrote the Host bundle in place, loaded an adjacent replacement module and could fall back silently. Those mechanisms were not adopted: grokbox uses exact reviewed transformation, its own roots, visible managed failure and an independently authorized controller. A source example of restarting/killing processes or loading credentials is not permission to execute it.

## Retired instructions

The old study also contained “ADOPT NOW”, stub-only ticket-14 and deferred-provider ticket-07 directions. They described that old milestone, not the current backend or delivery sequence. They have been removed from the current maintainer entry. The useful ABI/ownership properties continue in [Host compatibility](../runtime/host-compatibility.md), [runtime acceptance](../runtime/acceptance.md) and executable tests.

Exact original study, copied source excerpts and their MIT attribution/license remain together in the committed historical version:

```bash
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/maintainers/grok-bot-setup-session.md
```

This summary copies no implementation excerpt. Optional historical recovery is not a public build dependency. Recheck current native source/contracts when accessor, stream, tool/usage or hook semantics change; the existence of this historical study does not qualify a new Host generation or authorize provider traffic.
