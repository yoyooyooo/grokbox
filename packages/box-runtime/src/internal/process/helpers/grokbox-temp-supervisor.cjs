"use strict";
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, realpathSync } = require("node:fs");

const specPath = process.argv[2];
if (!specPath) process.exit(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (typeof spec.execPath !== "string" || !Array.isArray(spec.argv) || typeof spec.env !== "object" || spec.env == null
  || !Number.isInteger(spec.umask) || spec.umask < 0 || spec.umask > 0o777) {
  process.exit(2);
}
process.umask(spec.umask);
const child = spawn(spec.execPath, spec.argv, {
  env: spec.env,
  cwd: typeof spec.cwd === "string" ? spec.cwd : undefined,
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});
let start = null;
try {
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  start = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
} catch { /* Unknown identity stays unknown. */ }
const ownStat = readFileSync("/proc/self/stat", "utf8");
const supervisor = { pid: process.pid, start: Number(ownStat.slice(ownStat.lastIndexOf(")") + 2).split(" ")[19]) };
let launch;
try {
  const { resolve } = require("node:path"), { createHash } = require("node:crypto");
  const digest = value => createHash("sha256").update(value).digest("hex");
  if (typeof spec.env.GROKBOX_BOX_RUNTIME_ROOT === "string" && typeof spec.env.GROKBOX_HOST_BUNDLE === "string"
    && resolve(spec.env.GROKBOX_HOST_BUNDLE) === resolve(spec.argv[0]) && ["identity", "route"].includes(spec.env.GROKBOX_PRELOAD_MODE)) {
    launch = { rootDigest: digest(resolve(spec.env.GROKBOX_BOX_RUNTIME_ROOT)), targetDigest: digest(resolve(spec.argv[0])),
      exeDigest: digest(realpathSync(spec.execPath)), argvDigest: digest(JSON.stringify([spec.execPath, ...spec.argv])),
      uid: process.getuid(), mode: spec.env.GROKBOX_PRELOAD_MODE };
  }
} catch { /* Missing launch provenance stays unavailable, never copied from a marker. */ }
function record(exitCode, signal) {
  const receipt = { ...(launch ? { launch } : {}), supervisor, operationId: spec.env.GROKBOX_OPERATION_ID, pid: child.pid, start, exitCode, signal };
  try {
    const target = `${specPath}.child.json`, temporary = `${target}.${process.pid}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(receipt)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, target);
    const directory = openSync(require("node:path").dirname(target), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { /* Parent treats missing evidence as unknown. */ }
}
record(null, null);
child.on("exit", (code, signal) => record(code, signal));
child.on("error", () => record(null, null));
child.unref();
if (child.pid == null) process.exit(1);
setInterval(() => {}, 1000);
