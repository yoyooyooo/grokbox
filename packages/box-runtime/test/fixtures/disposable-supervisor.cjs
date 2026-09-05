"use strict";
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const hostPath = process.argv[2];
const pidFile = process.argv[3];
function launch() {
  const child = spawn(process.execPath, [hostPath], { stdio: "ignore" });
  if (child.pid != null) writeFileSync(pidFile, `${child.pid}\n`);
  child.on("exit", () => launch());
}
launch();
setInterval(() => {}, 1000);
