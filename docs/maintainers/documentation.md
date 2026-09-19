# Documentation maintenance

No repository surface is self-authenticating. A source branch shows what may execute; a test shows what its setup and assertions observed. Neither establishes that the behavior is correct.

## Verify before keeping a claim

- Identify the affected entry point and an observation that could disprove the claim. Execute it where possible; inspect whether the test's expected result merely repeats the implementation.
- Verify upstream behavior against a current primary source or an identified native version. A private evidence placeholder, old line number or source hash alone is not reproducible proof.
- Keep intent, observed implementation and deployment evidence separate. Mark unsupported claims **unverified**; remove obsolete instructions and unverifiable explanatory detail.
- Fix the owning text and its consumers together. Prefer a few key points and a reproducible command over another spec, status table or dated override paragraph.
- Preserve only necessary links, distinct unresolved decisions and useful bounded evidence. Git already retains committed obsolete text; unknown external bookmarks are not a reason to preserve every old rule.

## Where to put the remaining information

| Material | Place |
| --- | --- |
| User-facing behavior and configuration | Product/configuration guides, with executable examples |
| Runtime mechanisms and their reasons | Relevant runtime guide and nearby source/test |
| Scoped unresolved work | Existing ticket, identified by full path |
| Observed integration result | [LIVE](../tickets/LIVE-integration-validation.md), linked to its bounded report |
| Historical observations | Existing reports/archive; unverified for a different version or deployment |
| Possible future work | Roadmap, explicitly separated from accepted requirements |

Entry files and Skills route to these places. Do not duplicate versions, test counts, temporary inventories or model-specific operating choreography.

## Check the change

Run `bun run check:docs` for links, examples and LIVE/receipt structure. Run affected behavior tests for changed commands or code, plus typecheck/build when appropriate. Do not write tests that freeze prose, a historical document count or a former phase's IDs as correctness.

Report what was observed, what was removed and what remains unverified. Correcting a document does not qualify a native deployment or close an unresolved product requirement.
