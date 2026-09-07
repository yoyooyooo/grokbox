import { spyOn } from "bun:test";
import * as dns from "node:dns";
import * as net from "node:net";
import * as credentials from "../src/modeld-credentials.ts";
import * as modeld from "../src/modeld.ts";

/** Fail before egress rather than counting after a real HTTP/DNS/TCP call. Only local Unix IPC is permitted. */
export function providerHardOff() {
  const counts = { fetch: 0, dns: 0, tcp: 0, credential: 0 };
  const fetch = globalThis.fetch;
  const connect = net.Socket.prototype.connect;
  const denyFetch = (..._args: unknown[]): never => { counts.fetch += 1; throw new Error("provider fetch hard-off"); };
  globalThis.fetch = Object.assign(denyFetch, { preconnect: denyFetch });
  const denyDns = (..._args: unknown[]): never => { counts.dns += 1; throw new Error("provider DNS hard-off"); };
  const denyCredential = (..._args: unknown[]): never => { counts.credential += 1; throw new Error("credential hard-off"); };
  const spies = [
    spyOn(dns, "lookup").mockImplementation(Object.assign(denyDns, { __promisify__: denyDns })),
    spyOn(dns.promises, "lookup").mockImplementation((() => { counts.dns += 1; throw new Error("provider DNS hard-off"); }) as typeof dns.promises.lookup),
    spyOn(modeld, "createFileEnvSecretResolver").mockImplementation(() => { counts.credential += 1; throw new Error("credential hard-off"); }),
    spyOn(credentials, "materializeApiKeyRef").mockImplementation(denyCredential as typeof credentials.materializeApiKeyRef),
    spyOn(credentials, "fingerprintApiKeyRef").mockImplementation(denyCredential as typeof credentials.fingerprintApiKeyRef),
    spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: never[]) {
      const flat = (args as unknown[]).flatMap((arg) => Array.isArray(arg) ? arg : [arg]);
      const unix = flat.some((arg) => (typeof arg === "string" && arg.startsWith("/")) ||
        (arg && typeof arg === "object" && "path" in arg && typeof arg.path === "string" && arg.path.startsWith("/")));
      if (!unix) { counts.tcp += 1; throw new Error("provider TCP hard-off"); }
      return connect.apply(this, args as never);
    }),
  ];
  return { counts, restore: () => { globalThis.fetch = fetch; for (const spy of spies) spy.mockRestore(); } };
}
