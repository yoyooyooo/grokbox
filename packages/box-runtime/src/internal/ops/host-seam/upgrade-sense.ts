export const UPGRADE_SENSE_ADAPTER_VERSION = "hso-0.upgrade-sense.v1";
export const UPGRADE_SENSE_SCHEMA_VERSION = 1;

const FORBIDDEN_RAW_KEYS = ["reason", "error", "command", "payload"] as const;

export type SenseErrorClass =
  | "unavailable"
  | "unauthorized"
  | "absent"
  | "stale"
  | "invalid"
  | "sensor_contract_changed";

export type SenseSourceKind = "rpc" | "ack" | "marker" | "installed" | "loaded" | "unknown";

export type UpgradeSenseInput = {
  schemaVersion?: number;
  advertised?: { version?: string; channel?: string };
  staged?: { commandId?: string; archiveDigest?: string; pending?: boolean };
  installed?: { entrySha?: string; version?: string; companionDigest?: string };
  loaded?: {
    hostPid?: number;
    start?: number;
    compileReceiptSha?: string | "unknown";
    gatewayPid?: number;
    gatewayGeneration?: string;
  };
  rpc?: { accepted?: boolean; method?: string; observedAt?: string };
  ack?: { present?: boolean; commandId?: string };
  marker?: { kind?: "applied" | "failed"; present?: boolean; version?: string };
};

export type UpgradeSenseVerdict = {
  adapterVersion: typeof UPGRADE_SENSE_ADAPTER_VERSION;
  schemaVersion: typeof UPGRADE_SENSE_SCHEMA_VERSION;
  sourceKind: SenseSourceKind;
  advertised: UpgradeSenseInput["advertised"];
  staged: UpgradeSenseInput["staged"];
  installed: UpgradeSenseInput["installed"];
  loaded: UpgradeSenseInput["loaded"];
  installationConsistency: "stable" | "transition" | "mixed" | "unknown";
  upgradeComplete: false;
  adoptEligible: false;
  attribution: SenseSourceKind;
  gaps: string[];
  freshness: { observedAt: string | null; pointerFreshness: "unknown" };
  errorClass?: SenseErrorClass;
  /** Archive/tgz digest is never promoted to installed entry/source SHA. */
  sourceSha: string | null;
};

export const UPGRADE_SENSE_DEFAULTS = {
  adapterVersion: UPGRADE_SENSE_ADAPTER_VERSION,
  schemaVersion: UPGRADE_SENSE_SCHEMA_VERSION,
  deferThresholdMs: { assumed: false as const, sla: false as const },
  rollbackWatchMs: { assumed: false as const, crossWriterLock: false as const },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasForbiddenRaw(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_RAW_KEYS as readonly string[]).includes(key)) return true;
    if (hasForbiddenRaw(value[key])) return true;
  }
  return false;
}

function shaLike(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseUpgradeSenseObservation(value: unknown):
  | { ok: true; observation: UpgradeSenseInput }
  | { ok: false; errorClass: SenseErrorClass } {
  if (!isRecord(value)) return { ok: false, errorClass: "invalid" };
  if (hasForbiddenRaw(value)) return { ok: false, errorClass: "invalid" };
  if (value.schemaVersion !== undefined && value.schemaVersion !== UPGRADE_SENSE_SCHEMA_VERSION) {
    return { ok: false, errorClass: "sensor_contract_changed" };
  }
  return { ok: true, observation: value as UpgradeSenseInput };
}

function sourceKindOf(input: UpgradeSenseInput): SenseSourceKind {
  const kinds: SenseSourceKind[] = [];
  if (input.rpc?.accepted === true) kinds.push("rpc");
  if (input.ack?.present === true) kinds.push("ack");
  if (input.marker?.present === true) kinds.push("marker");
  if (typeof input.installed?.entrySha === "string") kinds.push("installed");
  if (input.loaded && (input.loaded.hostPid !== undefined || input.loaded.gatewayGeneration !== undefined)) {
    kinds.push("loaded");
  }
  if (kinds.length === 1) return kinds[0]!;
  if (kinds.length === 0) return "unknown";
  return "unknown";
}

export function classifyUpgradeSense(input: UpgradeSenseInput, previous?: UpgradeSenseInput): UpgradeSenseVerdict {
  const parsed = parseUpgradeSenseObservation({ ...input, schemaVersion: input.schemaVersion ?? UPGRADE_SENSE_SCHEMA_VERSION });
  if (!parsed.ok) {
    return {
      adapterVersion: UPGRADE_SENSE_ADAPTER_VERSION,
      schemaVersion: UPGRADE_SENSE_SCHEMA_VERSION,
      sourceKind: "unknown",
      advertised: undefined,
      staged: undefined,
      installed: undefined,
      loaded: undefined,
      installationConsistency: "unknown",
      upgradeComplete: false,
      adoptEligible: false,
      attribution: "unknown",
      gaps: [parsed.errorClass],
      freshness: { observedAt: input.rpc?.observedAt ?? null, pointerFreshness: "unknown" },
      errorClass: parsed.errorClass,
      sourceSha: null,
    };
  }

  const kind = sourceKindOf(input);
  const gaps: string[] = [];
  let installationConsistency: UpgradeSenseVerdict["installationConsistency"] = "unknown";

  if (input.staged?.pending === true) {
    installationConsistency = "transition";
    gaps.push("staged_pending");
  }
  if (input.marker?.kind === "failed") {
    installationConsistency = "mixed";
    gaps.push("failed_marker_disk_unknown");
  }
  if (previous?.marker?.present === true && input.marker?.present === false) {
    gaps.push("marker_absent_not_negative");
    installationConsistency = "unknown";
  }
  if (input.advertised?.version && input.installed?.version && input.advertised.version === input.installed.version) {
    if (previous?.installed?.entrySha && input.installed.entrySha && previous.installed.entrySha !== input.installed.entrySha) {
      installationConsistency = "mixed";
      gaps.push("same_version_different_bytes");
    }
  }
  if (
    previous?.installed?.entrySha
    && input.installed?.entrySha
    && previous.installed.entrySha === input.installed.entrySha
    && previous.loaded?.hostPid !== undefined
    && input.loaded?.hostPid !== undefined
    && previous.loaded.hostPid !== input.loaded.hostPid
  ) {
    gaps.push("same_sha_new_pid_activation_only");
    installationConsistency = installationConsistency === "mixed" ? "mixed" : "stable";
  }
  if (kind === "rpc" || kind === "ack" || kind === "marker") {
    gaps.push("declaration_is_not_installed_bytes");
  }
  if (input.loaded?.compileReceiptSha === "unknown" || input.loaded?.compileReceiptSha === undefined) {
    gaps.push("loaded_sha_unknown");
  }

  const sourceSha = shaLike(input.installed?.entrySha) ? input.installed!.entrySha! : null;
  if (input.staged?.archiveDigest && sourceSha && input.staged.archiveDigest === sourceSha) {
    gaps.push("archive_digest_must_not_equal_source");
  }

  return {
    adapterVersion: UPGRADE_SENSE_ADAPTER_VERSION,
    schemaVersion: UPGRADE_SENSE_SCHEMA_VERSION,
    sourceKind: kind,
    advertised: input.advertised,
    staged: input.staged,
    installed: input.installed,
    loaded: input.loaded,
    installationConsistency,
    upgradeComplete: false,
    adoptEligible: false,
    attribution: kind,
    gaps,
    freshness: { observedAt: input.rpc?.observedAt ?? null, pointerFreshness: "unknown" },
    sourceSha,
  };
}
