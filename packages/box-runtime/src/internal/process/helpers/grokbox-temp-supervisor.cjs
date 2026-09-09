"use strict";
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");

const specPath = process.argv[2];
if (!specPath) process.exit(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (typeof spec.execPath !== "string" || !Array.isArray(spec.argv) || typeof spec.env !== "object" || spec.env == null) {
  process.exit(2);
}
const child = spawn(spec.execPath, spec.argv, {
  env: spec.env,
  cwd: typeof spec.cwd === "string" ? spec.cwd : undefined,
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});
child.unref();
if (child.pid == null) process.exit(1);
setInterval(() => {}, 1000);
