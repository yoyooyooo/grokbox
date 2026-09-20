# grokbox Context

## Product

`grokbox` is an unofficial CLI and control plane for Grok Bot cloud computers. Development centers on the CLI/runtime inside one Box. Existing external Profile, daemon, SSH, Sandbox and quota capabilities remain supported only within their implemented and qualified scope; they do not imply that every runtime command works remotely. Network installation, routing and access policy belong to the operator, not to the model runtime.

The published package exposes `grokbox` and its exact alias `gbox`. Unpublished workspaces separate the CLI, shared browser-safe management client, Effect management Server, reusable runtime kernel, and Box/Host adapters. The destructive rebuild is in progress; [CLI-05](docs/tickets/CLI-05-implementation-follow-through.md) distinguishes connected capabilities from remaining migration work. The Host retains the native Agent loop and state writers; grokbox adds governed operations, per-Bot model selection, context maintenance and observation rather than replacing the upstream product.

## Find evidence to check

| Question | Source |
| --- | --- |
| Available commands, arguments and capabilities | [CLI registry](packages/cli/src/registry.ts), command help, executable tests |
| Shared management transport and authenticated entry | [client](packages/client/src/client.ts), [Server](packages/server/src/server.ts), [installed root](packages/server/src/installed.ts) |
| Node/Bun requirements, workspaces and runtime dependencies | [package.json](package.json), [bun.lock](bun.lock) |
| Configuration fields, defaults and revisions | [configuration guide](docs/configuration.md) and its schema/source links |
| Host/modeld protocol version | [wire contract](packages/runtime-kernel/src/internal/contract/wire.ts) |
| Current loaded installation and live qualification | [LIVE index](docs/tickets/LIVE-integration-validation.md) and its fixed-window evidence; re-observe before mutation |

Do not copy version numbers, test counts or deployment status into this entry. Source integration, offline verification, native compatibility and actual adoption are separate claims. These routes do not certify their contents; verify the behavior you intend to rely on.

## Vocabulary and authority

**Box** is the Linux execution environment. **Bot** is the upstream Agent identity. **Gateway** is the discovered native product API; **management Server** owns the new authenticated domain entry. The earlier **daemon** and **Profile** paths remain only for capabilities not yet migrated. New management calls use fixed-local or explicit pinned connections; Bot model calls require native UUIDs or installation-scoped refs, not display-name inference. **Sandbox** is the external machine-lifecycle control plane. **Quota** comes from one explicitly configured credential-owning source.

Server registration owns execution ownership; native Host writers own Box conversation state. CLI configuration expresses future intent; observed process state and execution receipts show what actually happened. See [architecture](docs/architecture.md).

Gateway, Sandbox, quota and desktop integration depend on undocumented upstream behavior and require scoped revalidation. Credentials for one surface do not authorize another. Private research and machine evidence are never public build dependencies.

[Documentation](docs/README.md) routes current contracts and operating guides. [Roadmap](docs/roadmap/README.md) owns remaining accepted work and candidates. [Archive](docs/archive/README.md) explains retired design and evidence without reviving old instructions.
