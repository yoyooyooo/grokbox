"use strict";
const { readFileSync, readlinkSync } = require("node:fs");

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

function contExact() {
  if (released) return;
  released = true;
  for (const ident of frozen) {
    try {
      if (sameIdentity(ident, inspect(ident.pid))) process.kill(ident.pid, "SIGCONT");
    } catch {
      /* gone or mismatch */
    }
  }
}

process.stdout.write("armed\n");
process.stdin.on("end", contExact);
process.stdin.on("error", contExact);
process.stdin.resume();
setTimeout(contExact, Math.max(1, deadlineMs));
