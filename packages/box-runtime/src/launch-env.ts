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

export function envHasProviderCredential(env: NodeJS.Dict<string>): boolean {
  return Object.keys(env).some((key) => /(?:API_KEY|ACME_)/i.test(key));
}
