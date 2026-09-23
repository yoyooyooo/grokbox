# grokbox

[English](./README.md) | [中文](./README.zh-CN.md)

Unofficial CLI and control plane primarily run inside a supported Grok Bot cloud
computer. Existing remote Profiles cover their established commands; new local
runtime capabilities do not require remote equivalents. The canonical command
is `grokbox`; `gbox` is an exact alias.

This project is not affiliated with or endorsed by Anysphere, Cursor, xAI, or
Grok Bot. Grok Bot, Cursor, and related names identify compatible products and
remain the property of their respective owners.

> **Alpha:** current source is `0.1.0-alpha.6`. npm `next` currently points to
> `0.1.0-alpha.5`; `0.0.1` remains `latest`. `v0.1.0-alpha.1` through
> `v0.1.0-alpha.4` exist as Git tags only. Prereleases publish only after
> release checks and explicitly scoped external acceptance.

> **Planned: native Bot assistance and fault notifications.** The accepted next step preserves bounded diagnostic evidence and sends a brief alert, incident IDs and retrieval commands to a separately paired Bot. Automatic alerts only remind by default; a user-delegated task can then drive troubleshooting, Bot management or model changes. This notification chain is **not shipped or enabled by this documentation change**, and does not automatically create Issues. Native Bot wakeups may incur model usage; data scope, retention limits and an off switch are part of the release contract. See the [implementation plan](docs/roadmap/template-ops-automation-spec.md).

## What it does

```text
Profile -> local daemon -> local Grok Bot Gateway
        -> configured HTTPS daemon over an operator-managed network
        -> explicit direct-local or Gateway compatibility path
        -> explicit Cursor Sandbox or quota compatibility adapter
```

Implemented command families:

```text
init  skills  profile  daemon  doctor  recover  box  quota
agents  groups  send  history  memory  events  is
fs  exec  jobs  desktop
```

Highlights:

- strict local and remote Profiles with separate credential authorities;
- finite Unix-socket/loopback daemon with operator-managed external endpoints;
- agent/group management, send, transcript, Memory, and bounded events;
- named-root governed file reads and mutations;
- literal structured execution with durable Jobs and bounded logs;
- layered read-only diagnosis and explicit recovery;
- opt-in Sandbox lifecycle, quota, and desktop compatibility adapters.

The daemon does not provide a generic raw RPC or shell. Gateway-only Profiles
never gain host filesystem or process authority.

## Two tracks

1. **Operate the official product** — Profile, daemon, `agents` / `send` / `history`.
   Run inside the Box by default; established remote command support remains available.
2. **Switch one Bot's brain** — on the computer: `grokbox on`, `grokbox host start`,
   `agents create`, then `bot model get/set` with a persisted request UUID and the observed revision. After a grokbox update:
   `grokbox upgrade --yes`. App New Bot is often **temporal** and never uses
   the custom-model channel.

Agents start with `grokbox skills get grokbox`: a small version-matched entry,
not the whole manual. Load only the capability needed, for example
`grokbox skills get grokbox --topic models`; `grokbox skills list` discovers topics.
`--full` is an explicit all-topics reference, not startup reading. Template stub:
[`skills/stubs/grokbox.md`](./skills/stubs/grokbox.md); do not copy full guides into a Bot.
`grokbox skills get core --full` remains the complete CLI inventory.

## Prerequisites and platform support

- Node.js 20.17.0+ for the published-style CLI runtime (including the native monitor SQLite dependency).
- Bun 1.3.14 for source development and the pre-release source shim.
- An existing Grok Bot cloud computer that you own or are authorized to use.
- For remote commands, a reachable operator-managed HTTPS endpoint and its daemon
  credential reference. Tailscale is optional infrastructure, not a CLI prerequisite.
- BatchMode SSH is optional for installed-daemon recovery. Only retained legacy
  peer/bootstrap operations require Tailscale; legacy bootstrap also needs npm or Bun.

| Role | Supported or tested |
| --- | --- |
| Source development | Linux and macOS |
| Node CLI | Linux and macOS |
| Box daemon, files, Jobs, desktop | Linux |
| Keychain secret references | macOS |
| Windows | Not currently supported or tested |

## Five-minute source quick start

```bash
git clone https://github.com/yoyooyooo/grokbox.git
cd grokbox
bun install --frozen-lockfile
bun run typecheck
bun run grokbox -- --help
bun run grokbox -- doctor
```

`doctor` is read-only. It reports each configured boundary separately and does
not wake a Sandbox, alter Tailscale Serve, start a daemon, or rotate a
credential.

Inside a running Grok Bot box, the no-file `default` Profile discovers the
loopback Gateway from `/home/box/sand-data/gateway.json`. If no local Gateway or
configured Profile is available, commands fail closed.

## Install

```bash
npm install --global grokbox@next
grokbox --version
gbox --help
```

Node.js 20 or newer is required. Bun is not required by the published package.

## Source-backed global shim

To test an unpublished checkout, install `grokbox` and `gbox` into
`~/.local/bin` while executing its TypeScript entry directly through Bun:

```bash
bun run shim:install
grokbox --version
gbox --help
grokbox doctor
```

The installer is idempotent, writes both aliases atomically, refuses to replace
an unrelated command, and verifies each installed command from outside the
repository. It records the absolute checkout and Bun paths, so rerun it after
moving the repository or Bun executable. This is a local-real source harness;
it does not replace the separate Node tarball verification.

The source shim loads the CLI modules in the checkout, then restores the caller's
working directory before running the same CLI entry owner. Relative input and
output paths and exported environment variables remain caller-owned. Automatic
Bun `.env` discovery is disabled for this shim so the loader's checkout does not
silently supply credentials or configuration; export required variables explicitly.
The published Node entry is unchanged by this source-loader policy.

## Local initialization and operator-managed endpoints

`grokbox init` initializes the local Box only. It does not discover Tailscale peers
or select remote Profiles. For established remote commands, configure an existing
endpoint explicitly (the credential value never belongs in argv):

```bash
grokbox profile add remote --transport daemon --server-url https://box.example.invalid:9443 --daemon-token-ref env:GROKBOX_REMOTE_TOKEN
grokbox profile use remote
grokbox doctor
```

DNS names, MagicDNS names and IPs use the same URL field and normal TLS validation.
The operator owns VPN, DNS, ACLs, certificates and proxy setup. The daemon retains
its Unix-socket/loopback listener; a user-managed HTTPS entry point may forward to
it. Non-loopback HTTP is still rejected. No public-internet exposure is required.

`doctor` checks endpoint and application health, not Tailscale/Serve state.
`recover` is a no-op for a healthy endpoint; otherwise it may ensure an installed
daemon through declared SSH. It never repairs the network by default, and only a
control-plane-confirmed sleeping Sandbox may be woken.

### Legacy compatibility only

Explicit `init --peer`, `daemon ensure --bootstrap --yes`, and
`recover --legacy-tailnet` retain the old bounded Tailscale/Serve deployment path.
They are not the recommended setup and are not expanded into network management.
Existing mappings and credentials are not automatically removed. Bootstrap still
requires confirmation; `--admit-home-read` is a separate explicit authority change.
See the [network boundary and legacy contract](docs/product-contract.md#2-默认入口与连接).

Future Web UI is a service inside the Box, reachable by external browsers through
a user-managed entry point. It does not require a remote runtime or Tailscale SDK;
application sessions, authorization and browser-origin protections remain required.

## Common safe probes

```bash
grokbox profile list --table
grokbox doctor
grokbox daemon status
grokbox agents list --table
grokbox groups list --table
grokbox history tail <target> --limit 20
grokbox memory list <agent>
grokbox export agent <agent> --out ./export
grokbox fs stat workspace:/artifact.txt
grokbox jobs list --table
grokbox desktop status --table
```

Mutating commands require explicit capability and, where destructive, explicit
confirmation. `desktop prune run` defaults to dry-run; `--yes` invokes the
upstream stop-window path and deletes that fork's Chrome profile.

## Credentials

Never pass Gateway, daemon, Sandbox, quota, SSH, or tailnet credentials on
argv, in issues, fixtures, snapshots, or ordinary logs.

Secret references are purpose-specific:

```text
env:<NAME>
file:<absolute-path>
keychain:<service>/<account>
```

A `file:` reference must resolve to a regular file owned by the current POSIX
user with no group or other permission bits; symbolic links are rejected.
Profiles never store inline tokens. Gateway, daemon, Sandbox, and quota
credentials are separate capabilities and are never substituted for one
another.

## Experimental compatibility surfaces

Grok Bot Gateway methods, Cursor Sandbox RPCs, the Cursor web quota endpoint,
and Grok Bot desktop layout are not documented upstream public APIs. Their
implementation may break without notice and does not imply provider
endorsement or authorization.

In particular:

- official Cursor OAuth has been observed to read Sandbox state but receive 401
  from `EnsureSandBox`;
- App-free wake and 24–72 hour keeper behavior are not stable claims;
- quota requires an explicit independent source and has source-local account
  binding;
- desktop prune is Linux/layout-specific and destructive when confirmed.

See [Compatibility and upstream boundary](docs/compatibility.md) before using
these surfaces. Users are responsible for the terms and policies applying to
their accounts and environments.

## Development and verification

```bash
bun install --frozen-lockfile
bun run check
```

The package test builds and packs locally, installs into an isolated system
Trash fixture, verifies both aliases under Node, checks the exact package
allowlist, and confirms project and third-party licenses are present. The
release-candidate workflow builds a downloadable artifact only. Exact version
tags publish through the separate OIDC Trusted Publishing workflow with npm
provenance; prereleases use `next`, stable versions use `latest`, and a GitHub
Release is created only after registry readback succeeds. See the
[release runbook](docs/maintainers/release.md); local release commands only
precheck and push an immutable tag, never publish from the maintainer machine.

Real external validation is intentionally separate and requires explicitly
injected authorized targets. Set `GROKBOX_EXTERNAL_PACKAGE` to an exact registry
version to test what users install rather than a locally packed tarball.
Fake-provider or local results do not prove provider authorization, long-lived
lease behavior, or destructive recovery.

## Documentation

- [Documentation map](https://github.com/yoyooyooo/grokbox/blob/main/docs/README.md)
- [Product contract](https://github.com/yoyooyooo/grokbox/blob/main/docs/product-contract.md)
- [Architecture](https://github.com/yoyooyooo/grokbox/blob/main/docs/architecture.md)
- [Compatibility boundary](https://github.com/yoyooyooo/grokbox/blob/main/docs/compatibility.md)
- [Upstream integration facts](https://github.com/yoyooyooo/grokbox/blob/main/docs/upstream-integration.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

Current behavior is owned by source and executable tests. Product and
architecture documents may describe accepted targets; roadmap entries and
GitHub issues do not prove delivery.

## License

MIT. See [`LICENSE`](LICENSE). The published bundle's third-party attributions
are in [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES).
