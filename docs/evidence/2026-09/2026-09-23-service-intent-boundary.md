# Service registration intent boundary · 2026-09-23

Base: `9f7728ada4d4879766c23058b3eb82b515025a87`.
Repair: `c8c86a0ba3c132d802959ed91b7dd9580604c453`.
This is public runtime validation, not a service manager or live installation.

The F1 independent review initially questioned staged retirement with start=true.
Reading the actual CLI caller established that it already rejects this combination.
The remaining issue was an exported-library contract gap, not a CLI incident.

The original runtimeServices owner now rejects non-boolean start, or start=true
outside install, before paths, state reads or manager observation. The public
command wrapper and direct owner share the check. Undefined and false retain
their meaning. No unit definition, lock, manager effect, lifecycle owner or saved
receipt format changed. Invalid calls cannot enter retirement recovery.

Seven negative cases failed before repair: 15 existing passes, seven failures,
one opt-in systemd parser not selected. After repair the complete suite plus
eight new cases passed: **24 pass, 0 fail/skip**, with the installed
systemd-analyze offline parser enabled. All manager actions and files were owned
fixtures, not live systemd state.

The fixed repair commit passed a seven-file cross-regression: **87 pass**, covering
staged-final recovery, packed CLI inspection, modeld lifetime/root identity and
operator semantics. Root/Web types, full build, boundaries, docs and publication
checks passed with declared Bun 1.3.14; no original assertion or timeout was relaxed.

The same independent source reviewer accepted this exact repair and closed the
invalid-input finding. It did not implement the change or run the tests. This
limited review does not attest the whole core candidate or live installation.

No current Host/modeld, user Bot, desktop, credentials or global shim was changed.
Task state and the actual integration SHA remain in Linear.
