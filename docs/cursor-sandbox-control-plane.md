# Cursor Sandbox Control Plane

This document defines the trust and lifecycle boundary for experimental box status, wake, and keepalive commands. The adapter is an upstream-private compatibility surface, not a stable provider contract.

## System boundary

```text
external client
  -> Sandbox control plane: inspect or attempt wake/lease
  -> private network: reach the resumed box
  -> grokbox daemon: governed box capabilities
  -> Grok Bot Gateway: product operations
```

These are independent authorities. A Gateway or daemon credential cannot wake a frozen box. A Sandbox credential does not grant Gateway, filesystem, process, SSH, or quota access.

## Commands

- `box status` performs a read-only lifecycle query.
- `box wake` requests one wake and verifies the returned execution descriptor with a bounded no-op.
- `box keepalive run` is a foreground experimental lease loop.
- `box keepalive status` reads only its protected, redacted local state.

Commands require an explicit `sandbox.access_token_ref` using an accepted secret-reference form. Configuration presence is reported as provider-authorization-dependent; only a successful method call proves authority for that method.

## Security rules

- Never discover or copy private application credentials implicitly.
- Never substitute a Gateway, daemon, quota, dashboard, or SSH credential.
- Keep access credentials out of argv, Profile JSON, logs, errors, evidence, and child environments not requiring them.
- Bound request bodies, response bodies, retries, backoff, and child-process settlement.
- Treat provider refusal as a stable failure, not a reason to probe hidden stores or alternate credentials.
- Do not claim wake or lease support merely because read-only status succeeds.

## Freeze and recovery semantics

Box process activity, daemon health, network reachability, and Sandbox lifecycle state are different observations. A network timeout alone does not prove hibernation; authentication, host-key, DNS, configuration, and local executable failures are inconclusive.

A recovery claim requires an independently scheduled external controller and all of:

1. an accepted lifecycle transition or explicit wake result;
2. private-network and strict SSH responsiveness;
3. daemon authentication and capability negotiation;
4. healthy `doctor.data.ok` including Gateway generation.

`doctor` remains read-only. `recover` is the explicit mutating composition. Neither silently installs Tailscale, changes ACLs, broadens daemon policy, or turns SSH into a business-command fallback.

## Keepalive qualification

A keeper is experimental until an authorized external test demonstrates both sustained availability while active and a correctly observed withdrawal/freeze transition. Qualification must:

- run outside the target box so it survives target hibernation;
- declare application and competing-activity preconditions;
- separate status observation from network stimulation;
- use monotonic timing and bounded immutable checkpoints;
- retain only typed states and booleans, never target names, credentials, command output, or product content;
- classify incomplete and inconclusive runs without converting them into success;
- verify recovery independently after the observation window.

Local and fake-provider tests prove harness behavior only. Machine-local experiment artifacts and private operational notes are not tracked in this public repository.

## Current claim limit

The implementation provides the typed adapter and safety boundaries. It does not promise that a normally available OAuth credential can call every lifecycle method, that App-free wake works for every account, or that the keeper replaces an official application connection for long periods.

## Freshness

Revalidate when lifecycle method schemas, authentication, descriptor framing, retry policy, freeze behavior, or application-supported control surfaces change.
