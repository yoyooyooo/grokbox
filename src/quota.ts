import type { CliDeps } from "./deps.ts";
import { CliError } from "./errors.ts";
import { isRecord } from "./util.ts";

export const CURSOR_WEB_QUOTA_ENDPOINT = "https://cursor.com/api/dashboard/get-sand-usage-status";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_PLAN_LENGTH = 128;

export type QuotaSnapshot = {
  hasAvailableUsage: boolean;
  hasIncludedLimit: boolean;
  usedPercent: number | null;
  remainingPercent: number | null;
  periodStart: string | null;
  resetsAt: string | null;
  plan: string | null;
  fetchedAt: string;
  freshness: "fresh";
  source: "cursor-web";
  accountBinding: "source-local";
};

type JwtClaims = { sub?: unknown; exp?: unknown };

function authorizationFailure(failureCode: string): CliError {
  return new CliError(
    "quota_authorization_failed",
    "The configured quota credential was not authorized for quota.read.",
    { failureCode },
  );
}

function protocolFailure(failureCode: string): CliError {
  return new CliError(
    "quota_protocol_unsupported",
    "The quota provider response did not satisfy the supported bounded protocol.",
    { failureCode },
  );
}

function providerFailure(failureCode: string, httpStatus?: number): CliError {
  return new CliError(
    "quota_provider_unavailable",
    "The quota provider did not return a fresh result.",
    { failureCode, ...(httpStatus === undefined ? {} : { httpStatus }), retryable: true },
  );
}

function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cursorWebIdentity(token: string, nowMs: number): string {
  if (
    token.length === 0 ||
    Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES ||
    token.includes("\r") ||
    token.includes("\n")
  ) {
    throw authorizationFailure("credential_malformed");
  }
  const claims = decodeJwtClaims(token);
  const subject = typeof claims?.sub === "string" ? claims.sub : "";
  const userId = subject.split("|").at(-1) ?? "";
  const expiry = typeof claims?.exp === "number" ? claims.exp : 0;
  if (!/^[A-Za-z0-9._-]+$/.test(userId)) throw authorizationFailure("credential_malformed");
  if (!Number.isFinite(expiry) || expiry * 1000 <= nowMs + 60_000) {
    throw authorizationFailure("credential_expired");
  }
  return userId;
}

async function readBoundedText(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw protocolFailure("response_oversized");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw protocolFailure("response_oversized");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function timestampIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 40) {
    throw protocolFailure(`${field}_invalid`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) throw protocolFailure(`${field}_invalid`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3));
  if (year < 1970 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    throw protocolFailure(`${field}_invalid`);
  }
  const millis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const date = new Date(millis);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw protocolFailure(`${field}_invalid`);
  }
  return date.toISOString();
}

function optionalPlan(payload: Record<string, unknown>): string | null {
  const candidate = payload.grokPlanLabel ?? payload.planLabel ?? payload.plan;
  if (candidate === undefined || candidate === null || candidate === "") return null;
  if (
    typeof candidate !== "string" ||
    candidate.length > MAX_PLAN_LENGTH ||
    candidate.trim() !== candidate ||
    /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(candidate)
  ) {
    throw protocolFailure("plan_invalid");
  }
  return candidate;
}

export function quotaSnapshotFromCursorWeb(payload: unknown, fetchedAtMs: number): QuotaSnapshot {
  if (!isRecord(payload)) throw protocolFailure("response_not_object");
  const hasAvailableUsage = payload.hasAvailableUsage;
  const hasIncludedLimit = payload.hasNonZeroIncludedLimit;
  if (typeof hasAvailableUsage !== "boolean" || typeof hasIncludedLimit !== "boolean") {
    throw protocolFailure("required_fields_invalid");
  }
  let usedPercent: number | null = null;
  let remainingPercent: number | null = null;
  if (hasIncludedLimit) {
    if (
      typeof payload.usagePercent !== "number" ||
      !Number.isFinite(payload.usagePercent) ||
      payload.usagePercent < 0 ||
      payload.usagePercent > 100
    ) {
      throw protocolFailure("usage_percent_invalid");
    }
    usedPercent = payload.usagePercent;
    remainingPercent = 100 - usedPercent;
  }
  const periodStart = timestampIso(payload.currentPeriodStart, "period_start");
  const resetsAt = timestampIso(payload.nextResetTimestampUtc, "reset_timestamp");
  if (periodStart !== null && resetsAt !== null && Date.parse(periodStart) > Date.parse(resetsAt)) {
    throw protocolFailure("period_order_invalid");
  }
  if (!Number.isSafeInteger(fetchedAtMs) || fetchedAtMs < 0) throw protocolFailure("fetched_at_invalid");
  return {
    hasAvailableUsage,
    hasIncludedLimit,
    usedPercent,
    remainingPercent,
    periodStart,
    resetsAt,
    plan: optionalPlan(payload),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    freshness: "fresh",
    source: "cursor-web",
    accountBinding: "source-local",
  };
}

export async function queryCursorWebQuota(
  deps: Pick<CliDeps, "fetch" | "now" | "signal">,
  token: string,
  timeoutMs: number,
): Promise<QuotaSnapshot> {
  const userId = cursorWebIdentity(token, deps.now());
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal?.aborted) controller.abort();
  else deps.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", abort);
  };
  let response: Response;
  try {
    response = await deps.fetch(CURSOR_WEB_QUOTA_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
        origin: "https://cursor.com",
      },
      body: "{}",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    cleanup();
    throw providerFailure(controller.signal.aborted ? "request_timeout" : "network_failure");
  }
  try {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw protocolFailure("redirect_refused");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw authorizationFailure("provider_refused");
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      throw providerFailure("provider_refused", response.status);
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        "quota_protocol_unsupported",
        "The quota provider method is unavailable or unsupported.",
        { failureCode: "unexpected_status", httpStatus: response.status },
      );
    }
    const text = await readBoundedText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw protocolFailure("response_not_json");
    }
    return quotaSnapshotFromCursorWeb(payload, deps.now());
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw providerFailure(controller.signal.aborted ? "request_timeout" : "network_failure");
  } finally {
    cleanup();
  }
}
