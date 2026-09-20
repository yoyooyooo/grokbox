import { execFileSync } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";

/** Test-only TLS termination to a fixed loopback Web listener. Its ephemeral
 * self-signed key is private, never published or installed into a trust store. */
export async function httpsFixture(directory: string, publicPort: number, upstreamPort: number) {
  const keyPath = join(directory, "test-tls.key"), certPath = join(directory, "test-tls.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore", timeout: 15_000 });
  await chmod(keyPath, 0o600);
  const server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath), maxHeaderSize: 16 * 1024 }, (incoming, outgoing) => {
    const proxy = httpRequest({ hostname: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, "x-forwarded-proto": "https" } }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    proxy.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on("error", () => proxy.destroy()); incoming.pipe(proxy);
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(publicPort, "127.0.0.1", () => { server.off("error", reject); accept(); }); });
  return { close: () => new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }) };
}
