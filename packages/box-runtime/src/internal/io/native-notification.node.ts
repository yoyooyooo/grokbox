import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { nativeAutomationIdentity, validatePairingCredential, validateNotificationBody, NOTIFICATION_DELIVERY_POLICY,
  type PairingPlan, type PairingCredential, type NotificationBinding, type NativeNotificationResult } from "@grokbox/runtime-kernel/observation";

/** Minimum public interop contract, not a general URL sender. The configured
 * native production backend is already used by the Sandbox/template adapters.
 * See docs/upstream-integration.md for the authoritative HTTP 200 boundary. */
export const NATIVE_NOTIFICATION_HTTP = Object.freeze({ version: 1, method: "POST", origin: "https://api2.cursor.sh",
  authentication: "bearer", acceptedStatus: 200, maxResponseBytes: 32768, timeoutMs: 10000, redirects: false, retries: 0 });
export const NATIVE_NOTIFICATION_HTTP_REVISION = sha256Text(canonicalJson(NATIVE_NOTIFICATION_HTTP));
export type NotificationRequest = (url: URL, options: RequestOptions, onResponse: (response: IncomingMessage) => void) => ClientRequest;
export type NativeNotificationInput = { plan: PairingPlan; credential: PairingCredential; binding: NotificationBinding;
  body: string; envelopeDigest: string; signal: AbortSignal; now?: () => number };
const unknown = (reason: "transport_failure" | "invalid_receipt" = "transport_failure"): NativeNotificationResult => ({ state: "unknown", reason });
const rejected = (reason: "revoked" | "expired" | "unsupported" | "policy_changed" | "native_rejected"): NativeNotificationResult => ({ state: "definitely-not-accepted", reason });

/** Request injection is an internal test boundary only, never an environment,
 * Profile, JSON, CLI flag or exported credential capability. Production always
 * uses Node HTTPS with normal certificate verification and no proxy/redirect. */
export async function sendNativeNotification(input: NativeNotificationInput, request: NotificationRequest = httpsRequest): Promise<NativeNotificationResult> {
  const now = input.now ?? Date.now;
  let endpoint: URL;
  try {
    const credential = validatePairingCredential(input.credential, input.plan);
    endpoint = new URL(credential.url);
    if (endpoint.origin !== NATIVE_NOTIFICATION_HTTP.origin || endpoint.pathname !== `/automations/webhook/${nativeAutomationIdentity(input.binding.agentId, input.binding.routineId)}`
      || !/^[\x21-\x7e]+$/.test(credential.key)) return rejected("unsupported");
    validateNotificationBody(input.body, input.envelopeDigest, input.binding, input.plan.target, now());
  } catch { return rejected("policy_changed"); }
  if (input.signal.aborted) return rejected("expired");
  const body = Buffer.from(input.body, "utf8");
  if (body.length > NOTIFICATION_DELIVERY_POLICY.maxBytes) return rejected("unsupported");
  return new Promise(resolve => {
    let req: ClientRequest | undefined, response: IncomingMessage | undefined, bytes = 0, done = false, closing = false;
    let requestClosed = false, responseClosed = false;
    let outcome = unknown();
    const finish = () => {
      if (done || !closing || !requestClosed || response && !responseClosed) return; done = true;
      clearTimeout(timer); input.signal.removeEventListener("abort", cancel);
      resolve(outcome);
    };
    const stop = (result: NativeNotificationResult) => {
      if (done || closing) return; closing = true; outcome = result;
      response?.destroy();
      if (req) req.destroy(); else requestClosed = true;
      finish();
    };
    const cancel = () => stop(unknown());
    const timer = setTimeout(cancel, NATIVE_NOTIFICATION_HTTP.timeoutMs);
    input.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (input.signal.aborted) { stop(rejected("expired")); return; }
      req = request(endpoint, { method: "POST", agent: false, rejectUnauthorized: true,
        headers: { authorization: `Bearer ${input.credential.key}`, "content-type": "application/json", "content-length": body.length } }, res => {
        response = res;
        // No server strings, Location, body or arbitrary headers reach receipts.
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > NATIVE_NOTIFICATION_HTTP.maxResponseBytes) stop(unknown("invalid_receipt"));
        });
        res.once("aborted", () => stop(unknown()));
        res.once("error", () => stop(unknown()));
        res.once("close", () => { responseClosed = true; if (!closing) stop(unknown()); finish(); });
        res.once("end", () => {
          if (done || closing) return;
          if (!res.complete) { stop(unknown()); return; }
          const status = res.statusCode;
          // 200 is documented acceptance, not completion or user-read. Unknown
          // success codes, redirects, proxies and 5xx remain uncertain here.
          const result: NativeNotificationResult = status === 200 ? { state: "native-accepted" }
            : status !== undefined && [400, 401, 403, 404, 409, 410, 413, 415, 422, 429].includes(status)
              ? rejected("native_rejected") : unknown("invalid_receipt");
          stop(result);
        });
      });
      req.once("error", () => stop(unknown()));
      req.once("close", () => { requestClosed = true; if (!response && !closing) stop(unknown()); finish(); });
      req.end(body);
    } catch { stop(unknown()); }
  });
}
