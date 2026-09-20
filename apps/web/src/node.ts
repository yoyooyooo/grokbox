import { serve } from "@hono/node-server";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWebRequest, WebBoundaryError, webConfiguration } from "./server/config.ts";

const mime: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
/** This module is bundled as dist/web/run.mjs, next to client/ and server/.
 * It serves only the build's assets and fetch handler; it never starts modeld,
 * management workers, native adapters or another domain writer. */
export async function startInstalledWeb() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! < 22 || major === 22 && minor! < 12) throw new Error("Web requires Node >=22.12.0.");
  const config = webConfiguration(), host = process.env.GROKBOX_WEB_HOST ?? "127.0.0.1";
  const port = Number(process.env.GROKBOX_WEB_PORT ?? "3100");
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid loopback Web listener.");
  const directory = dirname(fileURLToPath(import.meta.url)), assetsRoot = await realpath(resolve(directory, "client"));
  const entry = await import(new URL("./server/server.js", import.meta.url).href) as { default: { fetch: (request: Request) => Promise<Response> } };
  if (typeof entry.default?.fetch !== "function") throw new Error("The Web server artifact is unavailable.");
  let stopping = false, active = 0;
  const fetchRequest = async (request: Request): Promise<Response> => {
    if (stopping || active >= 64) return new Response("The console is stopping or at capacity.", { status: 503 });
    active++;
    try {
      checkWebRequest(request, config);
      const url = new URL(request.url);
      if (url.pathname.startsWith("/assets/")) {
        if (!["GET", "HEAD"].includes(request.method) || !/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname) || !mime[extname(url.pathname)]) return new Response("Not found.", { status: 404 });
        let file;
        try {
          const path = await realpath(resolve(assetsRoot, `.${url.pathname}`));
          if (!path.startsWith(`${assetsRoot}${sep}`)) throw new Error();
          file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error();
          return new Response(request.method === "HEAD" ? null : await file.readFile(), { headers: {
            "content-type": mime[extname(url.pathname)]!, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
          } });
        } catch { return new Response("Not found.", { status: 404 }); }
        finally { await file?.close(); }
      }
      return await entry.default.fetch(request);
    } catch (error) {
      return new Response(error instanceof WebBoundaryError ? error.message : "The console request could not be completed.", { status: error instanceof WebBoundaryError ? error.status : 503, headers: { "cache-control": "no-store" } });
    } finally { active--; }
  };
  const server = await new Promise<Server>((accept, reject) => {
    const listener = serve({ fetch: fetchRequest, hostname: host, port, overrideGlobalObjects: false,
      createServer, serverOptions: { maxHeaderSize: 16 * 1024 } }, () => { listener.off("error", failed); accept(listener as Server); });
    const failed = () => reject(new Error("The Web listener could not start."));
    listener.once("error", failed);
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
  server.maxConnections = 128; server.maxHeadersCount = 32;
  let closePromise: Promise<void> | undefined;
  return { origin: config.binding.origin, installationId: config.binding.installationId, server,
    close: () => closePromise ??= new Promise<void>((accept, reject) => {
      stopping = true;
      const deadline = setTimeout(() => server.closeAllConnections(), 20_000);
      server.close(error => { clearTimeout(deadline); error ? reject(new Error("Web listener cleanup failed.")) : accept(); });
      server.closeIdleConnections();
    }),
  };
}
export async function runWebServer(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): Promise<void> {
  const web = await startInstalledWeb();
  stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "system.service.run", ok: true, installationId: web.installationId,
    data: { component: "web", state: "running", origin: web.origin, pid: process.pid } })}\n`);
  await new Promise<void>((accept, reject) => {
    const cleanup = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); web.server.off("error", failed); web.server.off("close", closed); };
    const stop = () => { void web.close().then(() => { cleanup(); accept(); }, error => { cleanup(); reject(error); }); };
    const failed = () => { cleanup(); void web.close().finally(() => reject(new Error("The Web listener failed."))); };
    const closed = () => { cleanup(); accept(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop); web.server.once("error", failed); web.server.once("close", closed);
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runWebServer().catch(() => { process.stderr.write("The Web service failed. Verify the installed artifact and pinned Web configuration.\n"); process.exitCode = 1; });
}
