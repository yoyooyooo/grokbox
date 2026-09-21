// Public, independently authored native status shape and disposable transport.
// Only test source: never a product RPC or a replacement Host.
const rpcString = () => v => typeof v === "string";
const rpcBoolean = () => v => typeof v === "boolean";
const rpcArray = check => v => Array.isArray(v) && v.every(check);
const rpcOptional = check => v => v === undefined || check(v);
const rpcObject = shape => v => v && typeof v === "object" && Object.keys(v).every(k => Object.hasOwn(shape, k)) && Object.entries(shape).every(([k, check]) => check(v[k]));
var hostStatusArgs = rpcObject({
  includeManagedCapabilities: rpcOptional(rpcBoolean())
});
var localToolPermissionResolution = null;
let nativeReads = 0, getterReads = 0;
const deps = { extensions: { api() { nativeReads++; throw Error("metadata must not read native data"); } }, getHealth() { nativeReads++; return { isBusy: false }; } };
const BASE_HOST_CAPABILITIES = [];
const hostCapabilities = async () => { nativeReads++; return []; };
const api = {
    getHostStatus: async ({ includeManagedCapabilities }) => ({
      ...deps.extensions.api("host-upgrade").getVersionState(),
      isBusy: deps.getHealth().isBusy,
      capabilities: includeManagedCapabilities ? await hostCapabilities(deps) : BASE_HOST_CAPABILITIES
    }),
    setBoxMigrating: async (args) => { return args; }
};
class ResumeShape {
  startUpgradeResume(marker17) {
    this.tm.upgradeResumeStore?.markPending(marker17);
    this.pauseResumeInFlightAgentIds.add(marker17.agentId);
  }
  finishUpgradeResume(marker17) { return marker17; }
}
function createCursorInferencePromptSession() { return { native: true }; }
const originals = new Map();
for (const s of Object.getOwnPropertySymbols(globalThis)) if (String(s).includes("grokbox")) originals.set(s, Object.getOwnPropertyDescriptor(globalThis, s));
let delay = 0, recorded = null;
const server = require("node:http").createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== "Bearer synthetic-witness-native") { res.writeHead(401); res.end(); return; }
    let body = ""; for await (const part of req) { body += part.toString(); if (body.length > 8192) throw Error("test input bound"); }
    const args = body ? JSON.parse(body) : {};
    if (req.url === "/api/getHostStatus") {
      if (!hostStatusArgs(args)) { res.writeHead(400); res.end(); return; }
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const result = await api.getHostStatus(args); recorded = result;
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result)); return;
    }
    if (req.url === "/test/control") {
      if (args.action === "replace" || args.action === "restore" || args.action === "getter") {
        const symbol = [...originals.keys()].find(s => String(s) === "Symbol(grokbox.box-runtime.route-session.v1)");
        if (!symbol) throw Error("session symbol missing");
        if (args.action === "restore") Object.defineProperty(globalThis, symbol, originals.get(symbol));
        else if (args.action === "getter") Object.defineProperty(globalThis, symbol, { configurable: true, get() { getterReads++; throw Error("unsafe getter"); } });
        else Object.defineProperty(globalThis, symbol, { configurable: true, writable: true, value: () => ({ changed: true }) });
      } else if (args.action === "exercise") {
        const count = Math.min(40, Math.max(1, args.count || 1));
        for (let i = 0; i < count; i++) {
          const value = inference.createSession(() => {}, { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", invocationId: "synthetic-turn" });
          if (!value.native) throw Error("native passthrough changed");
        }
      } else if (args.action === "managed-stream") {
        // Independently drive the actual managed main stream, optionally without
        // its separate native compact lease. There is deliberately no modeld,
        // Bot database, credential or Provider in this disposable test process.
        const count = Math.min(12, Math.max(1, args.count || 1));
        for (let i = 0; i < count; i++) {
          const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", turnId = require("node:crypto").randomUUID(), stepId = require("node:crypto").randomUUID();
          const session = inference.createSession(() => {}, { agentId, invocationId: turnId });
          if (typeof session.getExecutor !== "function") throw Error("managed session missing");
          const executor = session.getExecutor([{ role: "system", content: "synthetic" }, { role: "user", content: "owned test" }]);
          const signal = new AbortController().signal;
          let lease;
          if (args.lease === true) lease = globalThis[Symbol.for("grokbox.box-runtime.host-compact.v1")]({
            agentId, turnId, invocationId: stepId, rootPromptExecutor: executor, stateHandler: {}, ctx: { signal }, stepClosed: () => false,
            orchestrator: { handleSummarization: async () => undefined }
          });
          try {
            const result = executor.stream({ signal }, stepId, [], { maxTokens: 16 });
            const response = result.response.catch(() => undefined);
            try { for await (const _ of result.fullStream) {} } catch {}
            await response;
          } finally { lease?.[Symbol.dispose](); }
        }
      } else if (args.action === "delay") delay = Math.min(5000, Math.max(0, args.ms || 0));
      else if (args.action !== "stats") throw Error("unknown test control");
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ nativeReads, getterReads, recorded })); return;
    }
    res.writeHead(404); res.end();
  } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
