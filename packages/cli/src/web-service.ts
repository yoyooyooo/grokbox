import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ManagementClientError, UUID } from "@grokbox/client";
import type { CliDeps } from "./deps.ts";

export type WebServiceOptions = { consoleOrigin?: string; managementUrl?: string; installationId?: string; port?: string; root?: string; nativeDiscovery?: string };
const invalid = () => new ManagementClientError("invalid_input", "Web service requires an explicit console origin, pinned installation and separate loopback management URL; native root/discovery options belong to server.");

/** Explicit lifecycle exception, not a business transport: one installed Web
 * child, no shell, arbitrary executable, credential forwarding or native owner.
 * A supervisor owns this foreground CLI; its stop only reaches this Web child. */
export async function runInstalledWebService(deps: CliDeps, options: WebServiceOptions): Promise<void> {
  const origin = options.consoleOrigin ?? deps.env.GROKBOX_WEB_ORIGIN;
  const managementUrl = options.managementUrl ?? deps.env.GROKBOX_MANAGEMENT_URL;
  const installationId = options.installationId ?? deps.env.GROKBOX_INSTALLATION_ID;
  const port = options.port ?? deps.env.GROKBOX_WEB_PORT ?? "3100";
  try {
    if (options.root || options.nativeDiscovery || !origin || !managementUrl || !installationId || !UUID.test(installationId)
      || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw invalid();
    const publicUrl = new URL(origin), upstream = new URL(managementUrl);
    const local = (host: string) => ["127.0.0.1", "localhost", "[::1]"].includes(host);
    if (publicUrl.origin !== origin || publicUrl.username || publicUrl.password
      || !(publicUrl.protocol === "https:" || publicUrl.protocol === "http:" && local(publicUrl.hostname))
      || upstream.origin !== managementUrl || upstream.protocol !== "http:" || !local(upstream.hostname)
      || upstream.username || upstream.password || origin === managementUrl) throw invalid();
  } catch { throw invalid(); }
  if (deps.signal?.aborted) throw new ManagementClientError("unavailable", "Web startup was interrupted before acquisition.");
  const entry = join(deps.packageRoot, "dist", "web", "run.mjs");
  try { if (!(await stat(entry)).isFile()) throw new Error(); }
  catch { throw new ManagementClientError("unavailable", "The installed Web artifact is missing. Build or install the complete distribution."); }
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.versions.bun ? "node" : process.execPath, [entry], { cwd: deps.packageRoot,
      stdio: ["ignore", "pipe", "pipe"], env: { PATH: deps.env.PATH ?? "", NODE_ENV: "production",
        GROKBOX_WEB_ORIGIN: origin, GROKBOX_MANAGEMENT_URL: managementUrl, GROKBOX_INSTALLATION_ID: installationId,
        GROKBOX_WEB_PORT: port, GROKBOX_WEB_HOST: "127.0.0.1" } });
    let announced = false, settled = false, failed = false, bytes = 0, text = "";
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); kill ??= setTimeout(() => child.kill("SIGKILL"), 25_000); } };
    const deadline = setTimeout(() => { failed = true; stop(); }, 15_000);
    const finish = (success: boolean) => {
      if (settled) return; settled = true;
      clearTimeout(deadline); clearTimeout(kill); deps.signal?.removeEventListener("abort", stop);
      success ? accept() : reject(new ManagementClientError("unavailable", "The installed Web service did not complete normally; inspect its artifact and explicit configuration."));
    };
    child.stdout.on("data", chunk => {
      if (announced) return;
      text += chunk.toString(); bytes += chunk.length;
      if (bytes > 16 * 1024) { failed = true; stop(); return; }
      if (!text.includes("\n")) return;
      try {
        const event = JSON.parse(text.slice(0, text.indexOf("\n")));
        if (event.schemaVersion !== 1 || event.ok !== true || event.installationId !== installationId!.toLowerCase()
          || event.data?.component !== "web" || event.data.state !== "running" || event.data.origin !== origin || event.data.pid !== child.pid) throw new Error();
        announced = true; clearTimeout(deadline); text = "";
        deps.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "system.service.run", invocationId: deps.randomUUID(), installationId: event.installationId,
          ok: true, data: { component: "web", state: "running", origin, pid: child.pid } })}\n`);
      } catch { failed = true; stop(); }
    });
    // Child diagnostics are private service logs, not an unbounded public CLI
    // envelope. Consume them without echoing paths, configuration or payloads.
    child.stderr.on("data", () => undefined);
    child.once("error", () => finish(false));
    child.once("close", (code, signal) => finish(!failed && announced && (code === 0 || Boolean(deps.signal?.aborted) && signal === "SIGTERM")));
    deps.signal?.addEventListener("abort", stop, { once: true });
    if (deps.signal?.aborted) stop();
  });
}
