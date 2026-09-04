# `grokbox quota`

This document owns the implemented account-quota command, explicit source configuration, output projection, and security boundary. Future sources remain in [Quota source expansion](roadmap/quota-query.md).

## Command

```text
grokbox quota [--json|--table] [--timeout-ms <n>]
gbox quota
```

The command asks one explicitly configured credential-owning source for a current account-quota snapshot. It does not estimate usage from transcripts, inspect box health, wake a Sandbox, or keep a box alive.

Profile v1 enables the current adapter only with a complete source declaration:

```json
{
  "version": 1,
  "quota": {
    "source": "cursor-web",
    "access_token_ref": "keychain:grokbox/quota"
  }
}
```

The reference accepts `env:`, protected absolute `file:`, or macOS `keychain:` forms. It is independent from the Sandbox credential reference and is never inferred from another capability.

## Output

A successful result contains one normalized snapshot:

```ts
interface QuotaSnapshot {
  hasAvailableUsage: boolean
  hasIncludedLimit: boolean
  usedPercent: number | null
  remainingPercent: number | null
  periodStart: string | null
  resetsAt: string | null
  plan: string | null
  fetchedAt: string
  freshness: "fresh"
  source: "cursor-web"
  accountBinding: "source-local"
}
```

Percentages are finite values in `[0,100]`; period timestamps are normalized and ordered; labels are bounded; and account identity, email, token subject, credentials, machine identity, headers, raw responses, and usage events are dropped. This adapter has no stale-cache fallback.

`accountBinding:"source-local"` means only that the result belongs to the selected credential source. It does not claim equality with the account provisioned inside a selected box.

## Adapter boundary

The `cursor-web` adapter:

1. resolves only `quota.access_token_ref`;
2. validates bounded token metadata in process memory;
3. sends one fixed, redirect-refusing, no-store request;
4. keeps a deadline active through bounded body consumption;
5. validates required provider fields and drops all others;
6. returns the normalized fresh DTO.

It never invokes Gateway, daemon, SSH, host filesystem/process APIs, Sandbox lifecycle, application launch, private application storage, or another source. Failure never triggers fallback.

The same command can run inside or outside a box. Missing or incomplete quota configuration returns `quota_unavailable` before unrelated discovery or host effects.

## Errors

| Error | Exit | Meaning |
| --- | ---: | --- |
| `quota_unavailable` | 60 | selected Profile has no complete supported quota source |
| `quota_authorization_failed` | 61 | credential is malformed/expired or provider returned 401/403 |
| `quota_protocol_unsupported` | 62 | redirect, unsupported status, malformed/oversized body, or invalid fields |
| `quota_provider_unavailable` | 63 | timeout, network failure, 408, 429, or 5xx |

Secret-reference failures retain the shared credential error taxonomy. A quota command without an accepted fresh result exits nonzero.

## Verification and freshness

Executable tests own request shape, source isolation, bounds, redaction, and failure behavior. Real-provider validation is maintainer-operated, explicitly authorized, and kept outside the public repository.

Revalidate when the endpoint, accepted token shape or scope, provider fields, account switching, Profile schema, or output projection changes.
