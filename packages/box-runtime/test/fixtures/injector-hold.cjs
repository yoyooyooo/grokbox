"use strict";
const { spawn } = require("node:child_process");
const guardian = process.argv[2];
const identityPath = process.argv[3];
const child = spawn(process.execPath, [guardian, identityPath], {
  stdio: ["pipe", "ignore", "ignore"],
  detached: true,
});
child.unref();
setInterval(() => {}, 1000);
