"use strict";
const { spawn } = require("node:child_process");
const guardian = process.argv[2];
const identityPath = process.argv[3];
const child = spawn(process.execPath, [guardian, identityPath], {
  stdio: ["pipe", "pipe", "ignore"],
  detached: true,
});
child.stdout?.once("data", (chunk) => {
  process.stdout.write(chunk);
});
child.unref();
setInterval(() => {}, 1000);
