# T5b — S2 streaming IPC (backlog)

## Goal
True streaming frames on `modeld.sock` (backpressure / cancel-of-partial). Host-facing `fullStream` is not empty-by-policy.

## Status
**backlog.** Do not implement in T5a. C1 credentials shipped separately as T5a.

## Driver
Herdr when owner opens this gate. No protocol change until then.
