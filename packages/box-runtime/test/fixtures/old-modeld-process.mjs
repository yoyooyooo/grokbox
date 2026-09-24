import { createServer } from 'node:net';
import { unlinkSync } from 'node:fs';
const [path, generation, rootId] = process.argv.slice(2);
const version = Number(process.env.TEST_WIRE_VERSION ?? 4);
const frame = value => { const bytes = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length); return Buffer.concat([head, bytes]); };
let fenced = false, probes = 0;
const server = createServer(socket => { let buffer = Buffer.alloc(0); socket.on('data', data => {
  buffer = Buffer.concat([buffer, data]); if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE()) return;
  const req = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE()).toString());
  if (req.version !== version) { socket.end(frame({ ok: false, version, error: { code: 'unsupported_version' } })); return; }
  if (req.method === 'fence-stop' && process.env.TEST_FENCE_SUPPORT === '1') {
    if (fenced || req.expectedEpoch !== generation || req.rootId !== rootId) { socket.end(frame({ ok: false, version, error: { code: 'busy' } })); return; }
    fenced = true;
    socket.once('close', () => { fenced = false; });
    socket.write(frame({ ok: true, method: req.method, version, serverGeneration: generation, rootId, fenced: true }));
    return;
  }
  if (req.method === 'execution-status') {
    const reply = () => socket.end(frame({ ok: true, method: req.method, version, serverGeneration: generation, execution: {
      version: 1, accepting: !fenced, ...(fenced ? { admission: 'operator-fenced' } : {}), lifetimeStepLimit: null, activeSteps: Number(process.env.TEST_ACTIVE_STEPS ?? 0), hotStepRecords: 0, hotTurns: 0, pinnedTurns: 0,
      history: { kind: 'leveldb', available: true, reads: 0, writes: 0, failures: 0, lastError: null },
      counters: { accepted: 0, duplicate: 0, completed: 0, reclaimedSteps: 0, coldRestores: 0, coldStores: 0, cleanupFailures: 0 }
    } }));
    if (++probes === 2 && process.env.TEST_STOP_BARRIER === '1') { process.send?.('idle-probe-blocked'); process.once('message', reply); }
    else reply();
    return;
  }
  if (req.method === 'service-info') socket.end(frame({ ok: true, method: req.method, version, serverGeneration: generation, rootId }));
  else if (req.method === 'health') socket.end(frame({ ok: true, method: req.method, version, serverGeneration: generation }));
  else socket.end(frame({ ok: false, version, error: { code: 'unknown_method' } }));
}); });
server.listen(path, () => process.stdout.write('ready\n'));
process.on('SIGTERM', () => server.close(() => { try { unlinkSync(path); } catch {} process.exit(0); }));
