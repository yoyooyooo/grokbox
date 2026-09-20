import { createIsomorphicFn } from "@tanstack/react-start";
import { CAPABILITIES, ManagementClient, ManagementClientError, UUID } from "@grokbox/client";
import type { ConsoleBinding, ConsoleBootstrap, PublicSession } from "./contracts.ts";
import { createSsrServices } from "../server/services.ts";
import { startEventWatch, type EventWatchListener } from "./event-watch.ts";

export type ConsoleServices = {
  bootstrap: () => Promise<ConsoleBootstrap>;
  client: (binding: ConsoleBinding) => ManagementClient;
  prepareWrite: (binding: ConsoleBinding, principalId: string) => Promise<ManagementClient>;
  watchEvents: (binding: ConsoleBinding, principalId: string, cursor: string, listener: EventWatchListener) => () => void;
};
function verifyBootstrap(value: unknown): ConsoleBootstrap {
  const data = value as ConsoleBootstrap | undefined;
  if (!data || data.binding?.origin !== window.location.origin || !UUID.test(data.binding?.installationId ?? "")
    || (data.session !== null && (!data.session || data.session.origin !== data.binding.origin
      || !UUID.test(data.session.sessionId) || typeof data.session.principalId !== "string"
      || !Number.isSafeInteger(data.session.expiresAt) || !Array.isArray(data.session.capabilities)
      || data.session.capabilities.some(item => !CAPABILITIES.includes(item)) || "csrfToken" in data.session))) {
    throw new ManagementClientError("protocol_error", "The console bootstrap is not valid for this origin.");
  }
  return data;
}
function createBrowserServices(): ConsoleServices {
  let current: { binding: ConsoleBinding; client: ManagementClient; csrf?: string } | undefined;
  let closeWatch: (() => void) | undefined;
  function client(binding: ConsoleBinding): ManagementClient {
    if (binding.origin !== window.location.origin) throw new ManagementClientError("wrong_installation", "The browser is not on the bound console origin.");
    if (!current || current.binding.installationId !== binding.installationId) {
      closeWatch?.(); closeWatch = undefined;
      const scope: NonNullable<typeof current> = { binding, client: undefined! };
      scope.client = new ManagementClient({ baseUrl: binding.origin, installationId: binding.installationId, console: { csrfToken: () => scope.csrf } });
      current = scope;
    }
    return current.client;
  }
  return {
    async bootstrap() {
      const response = await fetch("/console/bootstrap", { credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new ManagementClientError("unavailable", "Console authentication is unavailable.");
      const body = await response.text();
      if (body.length > 16_384) throw new ManagementClientError("protocol_error", "Console bootstrap is too large.");
      return verifyBootstrap(JSON.parse(body));
    },
    client,
    watchEvents(binding, principalId, cursor, listener) {
      closeWatch?.();
      const stop = startEventWatch(client(binding), principalId, cursor, listener); closeWatch = stop;
      return () => { stop(); if (closeWatch === stop) closeWatch = undefined; };
    },
    async prepareWrite(binding, principalId) {
      const api = client(binding), session = (await api.consoleSession()).data;
      if (session.principalId !== principalId) throw new ManagementClientError("authentication_required", "The signed-in identity changed. Reload before writing.");
      current!.csrf = session.csrfToken;
      return api;
    },
  };
}

/** Each router owns its service instance. SSR captures one request, never a
 * process-global user's cookie/cache. Only public bootstrap enters route data. */
export const createConsoleServices = createIsomorphicFn().server(createSsrServices).client(createBrowserServices);
export function publicSession(session: PublicSession): string { return `${session.principalId}:${session.sessionId}`; }
export function announceSessionChange(): void {
  try { localStorage.setItem("grokbox:console-session-change", crypto.randomUUID()); } catch { /* No credentials or session state are stored here. */ }
}
