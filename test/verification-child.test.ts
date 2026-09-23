import { expect, test } from "bun:test";
const moduleUrl = new URL("../scripts/verification-child.mjs", import.meta.url).href;
const { verificationChild } = await import(moduleUrl);
const node = (code: string) => ["node", "--input-type=module", "-e", code];
const options = { env: { PATH: process.env.PATH ?? "" }, timeoutMs: 3000, graceMs: 50 };

test("verification waits for actual child close and propagates nonzero or spawn failure", async () => {
  const good = await verificationChild(node('process.stdout.write("complete");'), options);
  expect(good).toMatchObject({ status: 0, error: null, settled: true, stdout: "complete" });
  expect(await verificationChild(node('process.exitCode=7;'), options)).toMatchObject({ status: 7, settled: true });
  expect(await verificationChild(["/does-not-exist/owned-test-executable"], options)).toMatchObject({ error: { code: "ENOENT" }, settled: true });
});

test("a child exit does not precede closure of inherited worker output", async () => {
  const result = await verificationChild(node(`import { spawn } from 'node:child_process';
    spawn(process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("owned-worker-closed"),150)'], {stdio:['ignore','inherit','inherit']});
    process.exit(0);`), options);
  expect(result).toMatchObject({ status: 0, error: null, settled: true });
  expect(result.stdout).toContain("owned-worker-closed");
});

test("cancellation joins an uncooperative directly owned child before returning", async () => {
  const controller = new AbortController();
  const result = await verificationChild(node('process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000);'), {
    ...options, signal: controller.signal, onOutput: (text: string) => { if (text.includes("ready")) controller.abort(); },
  });
  expect(result).toMatchObject({ error: { code: "ABORTED" }, signal: "SIGKILL", settled: true });
});

test("deadline and bounded output are explicit failed receipts, not partial passes", async () => {
  const timed = await verificationChild(node('setInterval(()=>{},1000);'), { ...options, timeoutMs: 100 });
  expect(timed).toMatchObject({ error: { code: "ETIMEDOUT" }, settled: true });
  const full = await verificationChild(node('process.stdout.write("x".repeat(10000)); setInterval(()=>{},1000);'), { ...options, maxOutputBytes: 128 });
  expect(full).toMatchObject({ error: { code: "OUTPUT_LIMIT" }, settled: true });
  expect(full.stdout.length).toBeLessThanOrEqual(128);
});

test("parent termination is forwarded and joined without starting the next shard", async () => {
  const controller = new AbortController();
  const script = `import { verificationChild, verificationSignals } from ${JSON.stringify(moduleUrl)};
    const owner=verificationSignals();
    try { const r=await verificationChild([process.execPath,'-e', 'process.on("SIGTERM",()=>{process.stdout.write("shutdown");process.exit(0)});process.stdout.write("ready");setInterval(()=>{},1000);'],
      {signal:owner.signal,timeoutMs:2000,graceMs:50,onOutput:text=>process.stdout.write(text)});
      process.stdout.write(JSON.stringify({settled:r.settled,error:r.error?.code,next:!owner.signal.aborted}));
    } finally { owner.dispose(); }`;
  const result = await verificationChild(node(script), { ...options, graceMs: 1500, signal: controller.signal,
    onOutput: (text: string)=> { if (text.includes("ready")) controller.abort(); } });
  expect(result).toMatchObject({ error: { code: "ABORTED" }, settled: true });
  expect(result.stdout).toContain('"settled":true'); expect(result.stdout).toContain('"next":false'); expect(result.stdout).toContain("shutdown");
});
