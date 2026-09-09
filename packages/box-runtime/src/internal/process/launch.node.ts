/** Default Host child stdio. Never a raw stdout/stderr file sink. */
export const HOST_CHILD_STDIO = ["ignore", "ignore", "ignore"] as const;

export const IDENTITY_LAUNCH_ALLOWLIST = [
  "HOME",
  "USER",
  "PATH",
  "LANG",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SAND_PACKAGED",
  "SAND_DATA_ROOT",
  "SAND_HOST_IN_BOX",
  "SAND_HOST_LOG_FILE",
  "SAND_GATEWAY_BIND_HOST",
  "SAND_HOST_PORT",
  "SAND_SUPERVISOR_ENABLED",
  "SAND_GATEWAY_TOKEN",
  /** Official Host inference renewer. Not a grokbox provider key; required for uncovered bots / create-bot. */
  "SAND_INFERENCE_RENEWAL_CREDENTIAL",
] as const;

const FORBIDDEN = /(?:API_KEY|SECRET|ACME_|GROKBOX_ALLOW_LIVE_HOST)/i;

export function pickLaunchEnv(
  source: NodeJS.Dict<string>,
): { ok: true; env: Record<string, string> } | { ok: false; code: "forbidden-env" } {
  const env: Record<string, string> = {};
  for (const key of IDENTITY_LAUNCH_ALLOWLIST) {
    if (FORBIDDEN.test(key) && key !== "SAND_GATEWAY_TOKEN") continue;
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return { ok: true, env };
}

/** Copy allowlisted fields the Host lost; used when adopt would otherwise spawn without official renewer delivery. */
export function fillMissingLaunchEnv(
  primary: NodeJS.Dict<string>,
  fallback: NodeJS.Dict<string>,
): NodeJS.Dict<string> {
  const out: NodeJS.Dict<string> = { ...primary };
  for (const key of IDENTITY_LAUNCH_ALLOWLIST) {
    const have = out[key];
    if (typeof have === "string" && have.length > 0) continue;
    const extra = fallback[key];
    if (typeof extra === "string" && extra.length > 0) out[key] = extra;
  }
  return out;
}

export function envHasProviderCredential(env: NodeJS.Dict<string>): boolean {
  return Object.keys(env).some((key) => /(?:API_KEY|ACME_)/i.test(key));
}
