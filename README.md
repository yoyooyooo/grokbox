# grokbox

[English](./README.md) | [中文](./README.zh-CN.md)

Unofficial CLI and control plane for operating Grok Bot cloud computers from
inside or outside the box. The canonical command is `grokbox`; `gbox` is an
exact alias.

This project is not affiliated with or endorsed by Anysphere, Cursor, xAI, or
Grok Bot. Grok Bot, Cursor, and related names identify compatible products and
remain the property of their respective owners.

> **Alpha:** current source is `0.1.0-alpha.6`. npm `next` currently points to
> `0.1.0-alpha.5`; `0.0.1` remains `latest`. `v0.1.0-alpha.1` through
> `v0.1.0-alpha.4` exist as Git tags only. Prereleases publish only after
> release checks and explicitly scoped external acceptance.

## What it does

```text
Profile -> local daemon -> local Grok Bot Gateway
        -> remote daemon over private Tailscale Serve
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
- finite Unix-socket/loopback daemon and private Tailscale Serve mapping;
- agent/group management, send, transcript, Memory, and bounded events;
- named-root governed file reads and mutations;
- literal structured execution with durable Jobs and bounded logs;
- layered read-only diagnosis and explicit recovery;
- opt-in Sandbox lifecycle, quota, and desktop compatibility adapters.

The daemon does not provide a generic raw RPC or shell. Gateway-only Profiles
never gain host filesystem or process authority.

## Prerequisites and platform support

- Node.js 20+ for the published-style CLI runtime.
- Bun 1.3.14 for source development and the pre-release source shim.
- An existing Grok Bot cloud computer that you own or are authorized to use.
- Tailscale plus BatchMode SSH for remote bootstrap/recovery; bootstrap also
  needs npm or Bun locally to repack the installed runtime for transfer.

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

## Remote initialization

Start with discovery and diagnosis. Bootstrap is an explicit privileged step:

```bash
grokbox init remote --peer <tailnet-peer>
grokbox doctor --profile remote

# Installs/replaces the grokbox daemon, rotates its credential, and applies only
# the recorded private Serve mapping. Requires BatchMode SSH and confirmation.
grokbox init remote --peer <tailnet-peer> --bootstrap --yes
```

Home reads are a separate authority transition and are never implied by
bootstrap:

```bash
grokbox init remote --peer <tailnet-peer> --bootstrap --admit-home-read --yes
```

Review the named filesystem roots and process allowlist before enabling host
capabilities.

## Common safe probes

```bash
grokbox profile list --table
grokbox doctor
grokbox daemon status
grokbox agents list --table
grokbox groups list --table
grokbox history tail <target> --limit 20
grokbox memory list <agent>
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
