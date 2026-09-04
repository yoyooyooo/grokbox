# Box Lifecycle and Tailnet Hardening

**Role:** deferred hardening candidates

The current product boundary remains in [Product contract](../product-contract.md): the daemon can run in the foreground, remote access uses an explicitly configured private endpoint, `doctor` is read-only, and `recover` is explicit. This roadmap does not promise autonomous startup or a universal Tailscale Serve layout.

## Daemon lifecycle

Before adding a supervisor, prove that the target environment exposes a supported user-owned startup hook across install, resume, crash, and recreation. Stop if the approach requires modifying an upstream supervisor contract or inventing a second general-purpose process manager.

Until such a hook is supported, bootstrap starts the daemon for the current environment and later absence is handled by explicit installed-daemon `ensure` or `recover`.

## Private endpoint ownership

Endpoint reconciliation must remain narrow and reversible:

- inspect existing state before mutation;
- own one exact recorded handler;
- preserve unrelated handlers;
- refuse drift or occupancy rather than taking over;
- never use a global reset as recovery;
- verify the final mapping and daemon authentication.

Do not generalize handler merging or migration until multiple real managed handlers create a demonstrated ownership conflict.

## Deferred candidates

- a bounded user-space restart supervisor;
- supported lifecycle adapters for additional hosts;
- multi-handler configuration ownership;
- explicit migration across incompatible network-tool versions.

Machine-specific experiments and endpoint evidence remain private maintainer material. Public source and tests own the reusable behavior.

## Freshness

Re-evaluate when target lifecycle hooks, process supervision, network-tool behavior, or daemon installation ownership changes.
