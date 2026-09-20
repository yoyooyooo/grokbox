import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { ConsoleGrant, ConsoleSession } from "@grokbox/client/contract";
import { HttpFailure, requireCapability, validateGrants, type AccessGrant, type Principal } from "./access.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const denied = () => new HttpFailure(401, "authentication_required", "The console session is missing, expired or revoked.");
const forbidden = () => new HttpFailure(403, "permission_denied", "The console request failed its origin or CSRF check.");
type Binding = { origin: string; authority: string; principal: Principal; expiresAt: number };
type Grant = Binding & { id: string };
type Session = Binding & { id: string; csrf: string };

export function consoleCookieName(origin: string): string {
  return origin.startsWith("https:") ? "__Host-grokbox-console" : "grokbox-console-local";
}
function cookie(origin: string, token: string, maxAge: number): string {
  return `${consoleCookieName(origin)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
}
function sessionCookie(header: string | undefined, origin: string): string {
  if (!header || header.length > 8192) throw denied();
  const names = ["__Host-grokbox-console", "grokbox-console-local"];
  const entries = header.split(";").map(part => part.trim().split("="));
  const found = entries.filter(parts => names.includes(parts[0]!));
  if (found.length !== 1 || found[0]!.length !== 2 || found[0]![0] !== consoleCookieName(origin) || !tokenPattern.test(found[0]![1]!)) throw denied();
  return found[0]![1]!;
}
function validPrincipal(binding: Binding, grants: readonly AccessGrant[]): Principal {
  validateGrants(grants);
  const current = grants.find(grant => grant.tokenSha256 === binding.authority && grant.principalId === binding.principal.id);
  if (!current) throw denied();
  return { id: current.principalId, capabilities: binding.principal.capabilities.filter(capability => current.capabilities.includes(capability)) };
}
function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new HttpFailure(400, "invalid_input", "Invalid console authentication input.");
  }
  return input as Record<string, unknown>;
}

/** Transient authentication only. Server restart invalidates grants and sessions;
 * durable business receipts remain with their domain and the same principal. */
export class ConsoleAuthority {
  private readonly grants = new Map<string, Grant>();
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly origins: ReadonlySet<string>, private readonly now: () => number = Date.now) {}

  private prune(): void {
    const now = this.now();
    for (const [key, item] of this.grants) if (item.expiresAt <= now) this.grants.delete(key);
    for (const [key, item] of this.sessions) if (item.expiresAt <= now) this.sessions.delete(key);
  }
  private origin(value: string | undefined): string {
    if (!value || !this.origins.has(value)) throw forbidden();
    return value;
  }
  issue(input: unknown, principal: Principal): ConsoleGrant {
    requireCapability(principal, "console.grants.create");
    const data = object(input, ["origin"]);
    if (typeof data.origin !== "string") throw new HttpFailure(400, "invalid_input", "An explicit console origin is required.");
    const origin = this.origin(data.origin);
    if (!principal.credentialSha256) throw forbidden();
    this.prune();
    if (this.grants.size >= 64) throw new HttpFailure(503, "unavailable", "The console bootstrap capacity is full; allow existing grants to expire.");
    const code = secret(), id = randomUUID(), expiresAt = this.now() + 5 * 60_000;
    this.grants.set(digest(code), { id, origin, expiresAt, authority: principal.credentialSha256,
      principal: { id: principal.id, capabilities: principal.capabilities.filter(capability => capability !== "console.grants.create") } });
    return { grantId: id, code, origin, expiresAt, persistence: "server-lifetime" };
  }
  redeem(input: unknown, requestOrigin: string | undefined, policy: readonly AccessGrant[]): { data: ConsoleSession; cookie: string } {
    const origin = this.origin(requestOrigin), data = object(input, ["code"]);
    if (typeof data.code !== "string" || !tokenPattern.test(data.code)) throw denied();
    this.prune();
    const key = digest(data.code), grant = this.grants.get(key);
    if (!grant || grant.origin !== origin) throw denied();
    const principal = validPrincipal(grant, policy);
    if (this.sessions.size >= 128) throw new HttpFailure(503, "unavailable", "The console session capacity is full.");
    const token = secret(), csrf = secret(), expiresAt = this.now() + 8 * 60 * 60_000;
    const session: Session = { id: randomUUID(), origin, principal, authority: grant.authority, csrf, expiresAt };
    this.grants.delete(key);
    this.sessions.set(digest(token), session);
    return { data: this.view(session, principal), cookie: cookie(origin, token, 8 * 60 * 60) };
  }
  private read(header: string | undefined, requestOrigin: string | undefined, policy: readonly AccessGrant[]) {
    const origin = this.origin(requestOrigin);
    this.prune();
    const key = digest(sessionCookie(header, origin)), session = this.sessions.get(key);
    if (!session || session.origin !== origin) throw denied();
    return { key, session, principal: validPrincipal(session, policy) };
  }
  private view(session: Session, principal: Principal): ConsoleSession {
    return { sessionId: session.id, principalId: principal.id, capabilities: [...principal.capabilities], origin: session.origin,
      expiresAt: session.expiresAt, csrfToken: session.csrf, persistence: "server-lifetime" };
  }
  authenticate(header: string | undefined, origin: string | undefined, csrf: string | undefined, mutation: boolean, policy: readonly AccessGrant[]): Principal {
    const { session, principal } = this.read(header, origin, policy);
    if (mutation && (!csrf || !tokenPattern.test(csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf)))) throw forbidden();
    return principal;
  }
  inspect(header: string | undefined, origin: string | undefined, policy: readonly AccessGrant[]): ConsoleSession {
    const { session, principal } = this.read(header, origin, policy);
    return this.view(session, principal);
  }
  logout(header: string | undefined, origin: string | undefined, csrf: string | undefined, policy: readonly AccessGrant[]): { signedOut: true; cookie: string } {
    this.authenticate(header, origin, csrf, true, policy);
    const { key, session } = this.read(header, origin, policy);
    this.sessions.delete(key);
    return { signedOut: true, cookie: cookie(session.origin, "", 0) };
  }
  close(): void { this.grants.clear(); this.sessions.clear(); }
}
