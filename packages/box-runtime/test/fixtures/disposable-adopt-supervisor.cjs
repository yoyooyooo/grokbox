"use strict";
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const hostPath = process.argv[2];
const pidFile = process.argv[3];
const specFile = process.argv[4];
const gatewayFile = process.argv[5];

function readPid() {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeGateway(pid) {
  if (!gatewayFile) return;
  writeFileSync(gatewayFile, `${JSON.stringify({ pid })}\n`);
}

function spawnHost() {
  let argv = [hostPath];
  let env = { ...process.env };
  try {
    const spec = JSON.parse(readFileSync(specFile, "utf8"));
    if (Array.isArray(spec.argv) && spec.argv.length > 0) argv = spec.argv;
    if (spec.env && typeof spec.env === "object") {
      env = spec.replaceEnv === true ? { ...spec.env } : { ...env, ...spec.env };
    }
  } catch {
    /* default host */
  }
  const child = spawn(process.execPath, argv, { env, stdio: "ignore" });
  if (child.pid != null) {
    writeFileSync(pidFile, `${child.pid}\n`);
    writeGateway(child.pid);
  }
}

function tick() {
  const pid = readPid();
  if (alive(pid)) {
    writeGateway(pid);
    return;
  }
  spawnHost();
}

tick();
setInterval(tick, 150);
