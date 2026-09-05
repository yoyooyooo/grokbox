"use strict";
const { spawn } = require("node:child_process");
const supervisor = process.argv[2];
const host = process.argv[3];
const pidFile = process.argv[4];
const specFile = process.argv[5];
spawn(process.execPath, [supervisor, host, pidFile, specFile].filter(Boolean), { stdio: "ignore" });
setInterval(() => {}, 1000);
