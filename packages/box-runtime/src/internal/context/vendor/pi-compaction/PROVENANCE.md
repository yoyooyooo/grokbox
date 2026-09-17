# Pi compaction extraction

Source: `@earendil-works/pi-agent-core@0.85.1`, MIT, copyright 2025 Mario Zechner.
Repository tag `v0.85.1`: `d981de1229ef899957bbe968bc8dcda02a21f477`.
Inspected published `dist/harness/compaction/compaction.js` SHA-256:
`fcaeb2e25d5cedca80e3487f8ec02014b0e780b68e67c33d579af7b80cc91dd7`.
Inspected published `dist/harness/compaction/utils.js` SHA-256:
`ab85613e2d299087a9882378da7d62adf77aa19130d16e502bbef45d82fc10b6`.

## Decision

Use one controlled extraction, not a runtime Pi Agent. The public package exposes
estimates, cut points, preparation and compact; it requires Node >=22.19.0 whereas
grokbox supports >=20.17.0. Its caller-owned request functions are internal only.
The public compact API expects a Models service and serializes tool results to
2000 characters before that service is called. A request callback cannot restore
already discarded material. Avoid a large fake Models object, hidden credential
resolution, unsupported engine claims, and an export-only patch that does not fix
material coverage. No Pi runtime dependency, absolute deep import, global Pi CLI,
or replacement Agent/session store is installed.

## Retained code and explicit adaptations

`core.ts` preserves the published usage/estimate, threshold, reverse retention
scan, legal non-tool-result cut selection and split-turn preparation algorithms.
Types are local and restrict input to the three message kinds our adapter actually
projects. App-specific bash/custom/branch entries and session reconstruction are
not admitted; unsupported data is rejected before projection. The Host supplies
the prior-summary boundary explicitly instead of Pi reconstructing a virtual
session. Assistant strings are normalized by the adapter; tool arguments must be
validated JSON, so the upstream unserializable fallback is not an input repair.

`prompts.ts` retains the upstream summary/update/split-turn templates. Material
serialization, token coverage, output limits and the one-request boundary live in
the grokbox algorithm adapter, outside this extraction. They use complete bounded
segments and reject incomplete/empty summaries, not the upstream 2000-character
truncator, implicit retry helper or Result.ok on length completion. Kernel owns
request effects/budgets; Host owns source references, root acceptance and storage.

No backend, telemetry, credential, tool execution, Context service or Pi session
implementation is copied. No vendor code is imported by Host/preload or kernel.

## Upgrade procedure

Pin a candidate package and source hashes; compare each retained function and
prompt, not just version numbers. Review upstream algorithm/serialization changes,
run independent golden/differential vectors and Node20 packaged probes, then record
the intentional delta here. Keep a single selected algorithm, never fallback
between direct/vendored modes. License is distributed in THIRD_PARTY_NOTICES.
Product acceptance, raw-material coverage and native persistence remain separate
from source equivalence. See CTX-00 and Spec S12 for qualification boundaries.
