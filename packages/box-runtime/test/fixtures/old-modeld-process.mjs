import { createServer } from 'node:net';
import { unlinkSync } from 'node:fs';
const [path, generation, rootId] = process.argv.slice(2);
const frame = value => { const bytes = Buffer.from(JSON.stringify(value)); const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length); return Buffer.concat([head, bytes]); };
const server = createServer(socket => { let buffer = Buffer.alloc(0); socket.on('data', data => {
  buffer = Buffer.concat([buffer, data]); if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE()) return;
  const req = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE()).toString());
  if (req.method === 'service-info') socket.end(frame({ ok: true, method: req.method, version: 4, serverGeneration: generation, rootId }));
  else if (req.method === 'health') socket.end(frame({ ok: true, method: req.method, version: 4, serverGeneration: generation }));
  else socket.end(frame({ ok: false, version: 4, error: { code: 'unknown_method' } }));
}); });
server.listen(path, () => process.stdout.write('ready\n'));
process.on('SIGTERM', () => server.close(() => { try { unlinkSync(path); } catch {} process.exit(0); }));
