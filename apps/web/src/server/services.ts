import { getRequest } from "@tanstack/react-start/server";
import { ManagementClientError } from "@grokbox/client";
import type { ConsoleServices } from "../lib/services.ts";
import { createConsoleBridge, type ConsoleBridge } from "./bridge.ts";
import { webConfiguration } from "./config.ts";

let bridge: ConsoleBridge | undefined;
/** Only immutable deployment settings and transport capacity live globally. */
export function consoleBridge(): ConsoleBridge { return bridge ??= createConsoleBridge(webConfiguration()); }
export function createSsrServices(): ConsoleServices {
  const request = getRequest(), transport = consoleBridge();
  const api = transport.readClient(request);
  return {
    bootstrap: () => transport.bootstrap(request),
    client: binding => {
      if (binding.installationId !== transport.config.binding.installationId || binding.origin !== transport.config.binding.origin) {
        throw new ManagementClientError("wrong_installation", "The SSR request belongs to a different console.");
      }
      return api;
    },
    prepareWrite: async () => { throw new Error("SSR cannot submit management writes."); },
    watchEvents: () => { throw new Error("SSR cannot own an event subscription."); },
  };
}
