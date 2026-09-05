"use strict";
const { readFileSync } = require("node:fs");

const identityPath = process.argv[2];
if (!identityPath) process.exit(2);
const payload = JSON.parse(readFileSync(identityPath, "utf8"));
const frozen = Array.isArray(payload.frozen) ? payload.frozen : [payload];
const deadlineMs = Number(payload.deadlineMs ?? 5000);
let released = false;

function contExact() {
  if (released) return;
  released = true;
  for (const ident of frozen) {
    try {
      const stat = readFileSync(`/proc/${ident.pid}/stat`, "utf8");
      const commEnd = stat.lastIndexOf(")");
      const rest = stat.slice(commEnd + 2).split(" ");
      const start = Number(rest[19]);
      if (start === ident.start) process.kill(ident.pid, "SIGCONT");
    } catch {
      /* gone or mismatch */
    }
  }
}

process.stdin.on("end", contExact);
process.stdin.on("error", contExact);
process.stdin.resume();
setTimeout(contExact, Math.max(1, deadlineMs));
