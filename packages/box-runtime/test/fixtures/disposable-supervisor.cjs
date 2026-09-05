"use strict";
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const hostPath = process.argv[2];
const pidFile = process.argv[3];
const specFile = process.argv[4];
function launch() {
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
  if (child.pid != null) writeFileSync(pidFile, `${child.pid}\n`);
  child.on("exit", () => launch());
}
launch();
setInterval(() => {}, 1000);
