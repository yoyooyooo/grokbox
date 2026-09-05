"use strict";
const { spawn } = require("node:child_process");
const supervisor = process.argv[2];
const host = process.argv[3];
const pidFile = process.argv[4];
const specFile = process.argv[5];
const gatewayFile = process.argv[6];
function start() {
  const child = spawn(
    process.execPath,
    [supervisor, host, pidFile, specFile, gatewayFile].filter(Boolean),
    { stdio: "ignore" },
  );
  child.on("exit", () => start());
}
start();
setInterval(() => {}, 1000);
