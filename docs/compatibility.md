# Compatibility and Upstream Boundary

`grokbox` is an independent, unofficial interoperability project. It is not
affiliated with, endorsed by, or supported by Anysphere, Cursor, xAI, or Grok
Bot. Product names are used only to identify the systems with which this tool
interoperates. The project does not use official logos or trade dress.

## Stability classes

| Surface | Status | Public commitment |
| --- | --- | --- |
| CLI registry, Profile format, output/error projection | alpha | Versioned by this repository |
| grokbox daemon, governed filesystem, Jobs | alpha | Versioned by this repository; Linux daemon |
| Tailscale/SSH bootstrap | alpha | Uses public tools but depends on local policy and versions |
| Grok Bot Gateway discovery and methods | experimental compatibility | Upstream-private, may break without notice |
| Cursor Sandbox status/wake/keeper | experimental compatibility | Upstream-private and method-authority dependent |
| Cursor web quota adapter | experimental compatibility | Explicit opt-in, source-local account binding only |
| Desktop classification/prune | experimental and destructive | Linux/Grok Bot layout-specific; dry-run first |

Experimental compatibility means implementation and tests exist, not that the
upstream provider documents, authorizes, or promises the interface. Users are
responsible for complying with the terms and policies that apply to their
accounts and environments. Provider refusal, rate limiting, protocol changes,
or account enforcement must not be bypassed.

## Credential and capability separation

Gateway, daemon, Sandbox, and quota credentials are separate authorities. A
credential accepted by one surface does not authorize another. Private App
credential discovery is not implemented. `file:` references are accepted only
for a current-user-owned regular file with no group or other permission bits;
symbolic links are rejected.

## Known holds

Read-only Sandbox status does not prove wake authority. App-free wake and
long-lived keeper behavior are not stable claims. Destructive recovery and
cross-environment behavior must be validated explicitly for each supported
release scope; private maintainer evidence is not a public runtime guarantee.

## Revalidation

Revalidate an adapter when upstream methods, schemas, tokens, endpoints, app
storage, Tailscale behavior, or Grok Bot filesystem/process layouts change.
Report suspected security issues through the private process in
[`SECURITY.md`](../SECURITY.md), not a public issue.
