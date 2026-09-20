import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { checkWebRequest, WebBoundaryError } from "./server/config.ts";
import { consoleBridge } from "./server/services.ts";

export default createServerEntry({
  async fetch(request) {
    try {
      const bridge = consoleBridge();
      checkWebRequest(request, bridge.config);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/")) return bridge.forward(request);
      if (url.pathname === "/console/bootstrap") {
        if (request.method !== "GET" || url.search) return new Response("Unsupported console bootstrap request.", { status: 400 });
        return Response.json(await bridge.bootstrap(request), { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      }
      if (!["GET", "HEAD"].includes(request.method)) return new Response("The console only exposes explicit management actions.", { status: 405 });
      const response = await handler.fetch(request);
      response.headers.set("cache-control", "no-store");
      response.headers.set("referrer-policy", "no-referrer");
      response.headers.set("x-content-type-options", "nosniff");
      response.headers.set("x-frame-options", "DENY");
      response.headers.set("content-security-policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
      return response;
    } catch (error) {
      return new Response(error instanceof WebBoundaryError ? error.message : "The console is unavailable. Verify its pinned deployment configuration and management service.",
        { status: error instanceof WebBoundaryError ? error.status : 503, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
    }
  },
});
