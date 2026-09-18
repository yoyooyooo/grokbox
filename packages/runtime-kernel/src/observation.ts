/** Payload-free observation contracts. Safe to import from the Host: no Effect,
 * SQLite, networking, configuration reads, or module-initialization effects. */
export * from "./internal/observation/evidence-contract.ts";
export * from "./internal/observation/incident-rules.ts";
export * from "./internal/observation/evidence-views.ts";
export * from "./internal/observation/retention-policy.ts";
export { effectiveStorage, type EffectiveStorage } from "./internal/config/storage-policy.ts";
export { CONFIG_SCHEMA_VERSION } from "./internal/config/version.ts";
