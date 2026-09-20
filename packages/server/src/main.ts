import { startInstalledManagementServer } from "./installed.ts";

// Private packaged supervisor entry; credentials are never accepted in argv.
async function main(): Promise<void> {
  const [root, discoveryPath, portText, consoleOrigin, ...rest] = process.argv.slice(2);
  if (!root || !discoveryPath || rest.length || (portText !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(portText))) throw new Error("invalid_service_arguments");
  const server = await startInstalledManagementServer({ root, discoveryPath, ...(portText === undefined ? {} : { port: Number(portText) }),
    ...(consoleOrigin ? { allowedOrigins: [consoleOrigin] } : {}) });
  let shutdown: Promise<void> | undefined;
  const stop = () => { shutdown ??= server.close(); void shutdown.catch(() => undefined); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, component: "server", state: "running", pid: process.pid,
      url: server.url, installationId: server.status().installationId })}\n`);
    await server.finished;
  } finally {
    stop();
    await shutdown;
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  }
}
void main().catch(() => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "unavailable", message: "The management Server could not start or close cleanly; inspect the selected installation." } })}\n`);
  process.exitCode = 1;
});
