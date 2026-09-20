import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CAPABILITIES } from "@grokbox/client/contract";
import { authenticate, type AccessGrant } from "../src/access.ts";
import { ConsoleAuthority } from "../src/console-access.ts";

const origin = "https://console.example.test";
const grant: AccessGrant = { tokenSha256: createHash("sha256").update("fixture-owner").digest("hex"), principalId: "owner", capabilities: [...CAPABILITIES] };
const principal = () => authenticate("Bearer fixture-owner", [grant]);
const cookieHeader = (value: string) => value.split(";")[0]!;

test("console code is one-use, origin-bound and separate from management authority", () => {
  const authority = new ConsoleAuthority(new Set([origin, "https://other.example.test"]));
  const issued = authority.issue({ origin }, principal());
  expect(issued.code).not.toContain("fixture-owner");
  expect(() => authority.redeem({ code: issued.code }, "https://other.example.test", [grant])).toThrow();
  const redeemed = authority.redeem({ code: issued.code }, origin, [grant]);
  expect(redeemed.cookie).toContain("__Host-grokbox-console=");
  expect(redeemed.cookie).toContain("; HttpOnly; SameSite=Strict;");
  expect(redeemed.cookie).toEndWith("; Secure");
  expect(redeemed.cookie).not.toContain("Domain=");
  expect(() => authority.redeem({ code: issued.code }, origin, [grant])).toThrow();
  const header = cookieHeader(redeemed.cookie);
  const sessionPrincipal = authority.authenticate(header, origin, undefined, false, [grant]);
  expect(sessionPrincipal.id).toBe("owner");
  expect(sessionPrincipal.capabilities).not.toContain("console.grants.create");
  expect(sessionPrincipal).not.toHaveProperty("credentialSha256");
  expect(() => authority.issue({ origin }, sessionPrincipal)).toThrow();
  expect(() => authenticate(`Bearer ${issued.code}`, [grant])).toThrow();
  expect(() => authority.authenticate(header, undefined, undefined, false, [grant])).toThrow();
  expect(() => authority.authenticate(header, "https://other.example.test", undefined, false, [grant])).toThrow();
});

test("cookie writes require session CSRF; logout revokes and clears without changing domain identity", () => {
  const authority = new ConsoleAuthority(new Set([origin]));
  const issued = authority.issue({ origin }, principal());
  const redeemed = authority.redeem({ code: issued.code }, origin, [grant]);
  const header = cookieHeader(redeemed.cookie), csrf = redeemed.data.csrfToken;
  expect(() => authority.authenticate(header, origin, undefined, true, [grant])).toThrow();
  expect(() => authority.authenticate(header, origin, "x".repeat(43), true, [grant])).toThrow();
  expect(authority.authenticate(header, origin, csrf, true, [grant]).id).toBe("owner");
  expect(authority.inspect(header, origin, [grant]).sessionId).toBe(redeemed.data.sessionId);
  expect(() => authority.authenticate(`${header}; ${header}`, origin, csrf, true, [grant])).toThrow();
  const removed = authority.logout(header, origin, csrf, [grant]);
  expect(removed.cookie).toContain("Max-Age=0");
  expect(() => authority.inspect(header, origin, [grant])).toThrow();
});

test("each console request consults policy; capability withdrawal and credential rotation do not inherit stale access", () => {
  const authority = new ConsoleAuthority(new Set([origin]));
  const issued = authority.issue({ origin }, principal());
  const redeemed = authority.redeem({ code: issued.code }, origin, [grant]);
  const header = cookieHeader(redeemed.cookie);
  expect(authority.inspect(header, origin, [{ ...grant, capabilities: ["bots.read"] }]).capabilities).toEqual(["bots.read"]);
  expect(() => authority.inspect(header, origin, [])).toThrow();
  expect(() => authority.inspect(header, origin, [{ ...grant, principalId: "replacement" }])).toThrow();
  expect(() => authority.inspect(header, origin, [{ ...grant, tokenSha256: "1".repeat(64) }])).toThrow();
  expect(() => authority.inspect(header, origin, [grant, grant])).toThrow();
});

test("bootstrap expires within five minutes and cannot grow without bound", () => {
  let now = 1_000_000;
  const authority = new ConsoleAuthority(new Set([origin]), () => now);
  const issued = authority.issue({ origin }, principal());
  for (let index = 1; index < 64; index++) authority.issue({ origin }, principal());
  expect(() => authority.issue({ origin }, principal())).toThrow();
  now += 5 * 60_000;
  expect(() => authority.redeem({ code: issued.code }, origin, [grant])).toThrow();
  expect(authority.issue({ origin }, principal()).expiresAt).toBe(now + 5 * 60_000);
});

test("session expiry, capacity and Server lifetime bound authentication without timers", () => {
  let now = 1_000_000;
  const authority = new ConsoleAuthority(new Set([origin]), () => now);
  const headers: string[] = [];
  for (let index = 0; index < 128; index++) {
    const issued = authority.issue({ origin }, principal());
    headers.push(cookieHeader(authority.redeem({ code: issued.code }, origin, [grant]).cookie));
  }
  const pending = authority.issue({ origin }, principal());
  expect(() => authority.redeem({ code: pending.code }, origin, [grant])).toThrow();
  now += 8 * 60 * 60_000;
  expect(() => authority.inspect(headers[0], origin, [grant])).toThrow();
  const fresh = authority.issue({ origin }, principal());
  const header = cookieHeader(authority.redeem({ code: fresh.code }, origin, [grant]).cookie);
  authority.close();
  expect(() => authority.inspect(header, origin, [grant])).toThrow();
});

test("loopback cookies are distinct and input cannot change scopes or capabilities", () => {
  const local = "http://127.0.0.1:3333";
  const authority = new ConsoleAuthority(new Set([local]));
  expect(() => authority.issue({ origin: local, capabilities: ["console.grants.create"] }, principal())).toThrow();
  expect(() => authority.issue({ origin: "http://external.example" }, principal())).toThrow();
  const issued = authority.issue({ origin: local }, principal());
  expect(() => authority.redeem({ code: issued.code, origin: local }, local, [grant])).toThrow();
  const redeemed = authority.redeem({ code: issued.code }, local, [grant]);
  expect(redeemed.cookie).toStartWith("grokbox-console-local=");
  expect(redeemed.cookie).not.toContain("; Secure");
});
