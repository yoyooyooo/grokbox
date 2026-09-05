"use strict";
const { spawn } = require("node:child_process");
const supervisor = process.argv[2];
const host = process.argv[3];
const pidFile = process.argv[4];
const node = process.execPath;
spawn(node, [supervisor, host, pidFile], { stdio: "ignore" });
setInterval(() => {}, 1000);
