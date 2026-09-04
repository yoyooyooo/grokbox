# Security Policy

## Supported versions

Until the first stable release, only the current `main` branch and the newest
alpha release candidate receive security fixes. The npm `0.0.1` snapshot is not
supported.

## Private reporting

Do not open a public issue containing credentials, private infrastructure,
provider responses, prompts, transcripts, Memory, file contents, or an
unpatched vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/yoyooyooo/grokbox/security/advisories/new).
If that form is unavailable, open a credential-free issue asking a maintainer
to establish a private channel; include no exploit details.

Please include only the minimum redacted information needed to reproduce the
problem:

- affected grokbox version or commit;
- operating system and Node/Bun versions;
- affected boundary (Gateway, daemon, filesystem, Job, Sandbox, quota);
- safe reproduction steps and impact;
- whether credentials may have been exposed.

Expect an acknowledgement within seven days. Timelines for a fix or disclosure
will be agreed after triage. Do not test against accounts, boxes, or tailnets
you do not own or have explicit permission to use.

## Credential exposure

Treat a suspected Gateway, daemon, Sandbox, quota, SSH, or tailnet credential
leak as an incident. Stop sharing logs, revoke or rotate the affected authority
through its owner, and preserve only redacted evidence. These credentials are
separate capabilities; rotating one does not rotate the others.

## Scope

Security defects in grokbox-owned code and its published package are in scope.
Upstream availability, undocumented provider behavior, account policy, and
provider-side vulnerabilities are not controlled by this project, but a
sanitized compatibility report is welcome.
