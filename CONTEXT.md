# grokbox Context

## Product

`grokbox` is an unofficial, Profile-based CLI and control plane for operating Grok Bot cloud computers from inside or outside the box. The Node package and source-backed development shim expose `grokbox` and the exact alias `gbox`.

## Current implementation

The TypeScript CLI currently provides:

- strict local, daemon, remote, and Gateway-compatible Profiles;
- protected `env:`, `file:`, and macOS `keychain:` secret references;
- idempotent local or Tailscale-peer initialization;
- a finite, capability-gated daemon over a Unix socket or authenticated loopback HTTP;
- typed Grok Bot roster, send, history, Memory, and event commands;
- governed named-root filesystem access and structured Linux Jobs;
- layered read-only diagnosis and explicit recovery;
- opt-in experimental Sandbox, quota, and desktop compatibility adapters.

Node.js 20+ is the published runtime. Bun is development tooling. Source and package checks run on Linux and macOS; host filesystem, process, Job, and desktop capabilities remain Linux-only.

## Compatibility boundary

Gateway methods, Sandbox lifecycle RPCs, quota endpoints, and desktop layouts are not documented upstream public APIs. They may change without notice and must remain explicit, narrowly typed, redacted, and fail-closed. A credential accepted by one surface never implies authority on another.

The project does not claim that App-free wake or long-lived keeper behavior works for every account or environment. Real-provider observations do not become product guarantees; tests and public contracts must remain valid without private research or machine-local evidence.

## Vocabulary

- **Grok Bot:** upstream product and host runtime.
- **box / cloud computer:** Linux environment hosting Grok Bot state and processes.
- **Gateway:** Grok Bot product API discovered inside the box.
- **daemon:** grokbox-owned host RPC for governed Gateway and host capabilities.
- **Profile:** selected connection and policy configuration.
- **target:** agent or group identity resolved ID-first and then by unambiguous name/title.
- **Sandbox control plane:** external lifecycle surface, separate from Gateway and daemon authority.
- **quota:** account-level usage state from one explicitly configured source.

## Authority

- Current behavior: source and executable tests.
- Accepted product behavior: `docs/product-contract.md`.
- Implementation ownership: `docs/architecture.md`.
- Required compatibility facts: `docs/upstream-integration.md`.
- Deferred work: `docs/roadmap/`.
- Public work intake: GitHub Issues.
