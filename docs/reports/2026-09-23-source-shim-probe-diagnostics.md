# Source-backed shim probe: bounded diagnostics

AH-170; baseline `078389fc7456131ec004021c9e28e421bc9d18d6`. This is a diagnostic checkpoint, not a startup reliability fix or merge approval.

## Observed

With declared Bun 1.3.14 and isolated HOME/configuration roots, the same TypeScript `--version` entry returned from the repository directory in 393/282 ms. An empty temporary cwd timed out at 10 seconds once and returned in 2857 ms on repetition; system tmp returned in 8118/3155 ms. These observations establish a cwd-correlated difference, not its underlying cause.

The original installer reproduces a 10-second `ETIMEDOUT`, SIGKILL, zero stdout and zero stderr. It is not a version mismatch. Further loader-variant diagnostics were not executed because the tool invocation was rejected. No loading workaround, alternate entry point, timeout extension, or real global shim change has been made.

## Delivered diagnostic change

The original probe still launches the installed alias against the real TypeScript entry and requires the exact package version. Its 10-second limit is unchanged. Failure includes only a fixed phase/alias/reason, exit status, signal, selected spawn error code, deadline and output byte counts. Raw stdout/stderr and environment values are not echoed; output collection is capped at 64 KiB.

Four synthetic-executable tests passed: nonzero exit, unexpected version, bounded-output overflow and timeout. The original three behavioral tests remain; the real install test still fails intermittently and has not been reclassified as an expected failure. Root typecheck, publication scan and diff checks passed for the diagnostic changes. Filtered diagnostic tests are not the full shim suite.

## Remaining

Determine the source startup root cause and fix the original loader/installer path without changing caller cwd semantics or substituting a version-only program. AH-170 remains In Progress; this checkpoint must not be merged as a completed reliability fix. Tests used owned temporary installation directories and did not modify services, credentials, Bots or the user's global commands.
