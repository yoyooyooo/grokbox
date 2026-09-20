import { UUID } from "@grokbox/client";
import type { ConsoleBinding } from "../lib/contracts.ts";

export type WebConfiguration = Readonly<{ binding: Readonly<ConsoleBinding>; managementUrl: string }>;

/** Deployment configuration, never request parameters or a shared current Profile.
 * Reverse proxies preserve Host; forwarded headers are deliberately not trusted. */
export function webConfiguration(env: Record<string, string | undefined> = process.env): WebConfiguration {
  const origin = env.GROKBOX_WEB_ORIGIN, managementUrl = env.GROKBOX_MANAGEMENT_URL;
  const installationId = env.GROKBOX_INSTALLATION_ID;
  try {
    if (!origin || !managementUrl || !installationId || !UUID.test(installationId)) throw new Error();
    const publicUrl = new URL(origin), upstream = new URL(managementUrl);
    const local = (host: string) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
    if (publicUrl.origin !== origin || publicUrl.username || publicUrl.password
      || !(publicUrl.protocol === "https:" || publicUrl.protocol === "http:" && local(publicUrl.hostname))
      || upstream.origin !== managementUrl || upstream.protocol !== "http:" || !local(upstream.hostname)
      || upstream.username || upstream.password || upstream.origin === publicUrl.origin) throw new Error();
    return Object.freeze({ binding: Object.freeze({ origin, installationId: installationId.toLowerCase() }), managementUrl });
  } catch {
    throw new Error("Configure a pinned installation, explicit HTTPS/loopback console origin, and separate loopback management URL.");
  }
}

export class WebBoundaryError extends Error {
  constructor(readonly status: number, readonly code: "permission_denied" | "invalid_input" | "wrong_installation" | "not_found" | "unavailable", message: string) {
    super(message);
  }
}

export function checkWebRequest(request: Request, config: WebConfiguration): void {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (host.toLowerCase() !== new URL(config.binding.origin).host.toLowerCase()) {
    throw new WebBoundaryError(403, "permission_denied", "The console Host is not allowed.");
  }
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if (origin !== null && origin !== config.binding.origin || site !== null && !["same-origin", "none"].includes(site)) {
    throw new WebBoundaryError(403, "permission_denied", "The console request is not same-origin.");
  }
  if (!["GET", "HEAD"].includes(request.method) && origin !== config.binding.origin) {
    throw new WebBoundaryError(403, "permission_denied", "Console writes require the configured Origin.");
  }
  if (request.headers.has("authorization")) throw new WebBoundaryError(403, "permission_denied", "The console accepts its own session, not management credentials.");
  if (request.url.length > 4096) throw new WebBoundaryError(400, "invalid_input", "The console request target is too large.");
}
