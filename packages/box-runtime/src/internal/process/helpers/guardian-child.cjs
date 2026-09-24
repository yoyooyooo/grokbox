"use strict";
const { readFileSync, readlinkSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } = require("node:fs");

const identityPath = process.argv[2];
if (!identityPath) process.exit(2);
const payload = JSON.parse(readFileSync(identityPath, "utf8"));
const frozen = Array.isArray(payload.frozen) ? payload.frozen : [payload];
const deadlineMs = Number(payload.deadlineMs ?? 5000);
let released = false;

function inspect(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commEnd = stat.lastIndexOf(")");
  const rest = stat.slice(commEnd + 2).split(" ");
  const ppid = Number(rest[1]);
  const start = Number(rest[19]);
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const uid = Number(status.split("Uid:")[1].trim().split(/\s+/)[0]);
  const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
  const exe = readlinkSync(`/proc/${pid}/exe`);
  return { pid, uid, start, exe, cmdline, ppid };
}

function sameIdentity(expected, observed) {
  if (!observed) return false;
  if (expected.pid !== observed.pid || expected.uid !== observed.uid || expected.start !== observed.start) return false;
  if (expected.exe !== observed.exe || expected.ppid !== observed.ppid) return false;
  if (expected.cmdline.length !== observed.cmdline.length) return false;
  return expected.cmdline.every((value, index) => value === observed.cmdline[index]);
}

function contExact(reason) {
  if (released) return;
  released = true;
  const continued = [];
  for (const ident of frozen) {
    try {
      if (sameIdentity(ident, inspect(ident.pid))) { process.kill(ident.pid, "SIGCONT"); continued.push({ pid: ident.pid, start: ident.start }); }
    } catch {
      /* gone or mismatch */
    }
  }
  try {
    const target = `${identityPath}.result.json`, temporary = `${target}.${process.pid}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify({ operationId: payload.operationId ?? null, reason, continued })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    const directory = openSync(require("node:path").dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Receipt absence is not proof that CONT was not sent. */ }
  process.stdout.end(`${reason}\n`, () => process.exit(0));
}

process.stdout.on("error", () => { if (released) process.exit(0); });
process.stdout.write("armed\n");
process.stdin.on("data", chunk => { if (String(chunk).trim() === "release") contExact("released"); });
process.stdin.on("end", () => contExact("owner-ended"));
process.stdin.on("error", () => contExact("lost"));
process.stdin.resume();
setTimeout(() => contExact("expired"), Math.max(1, Math.min(deadlineMs, (payload.expiresAt ?? Date.now() + deadlineMs) - Date.now())));
