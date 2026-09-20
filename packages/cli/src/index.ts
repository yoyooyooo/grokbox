#!/usr/bin/env node
import { createProductionDeps } from "./deps.ts";
import { runCli } from "./program.ts";

const controller = new AbortController();
const abort = () => controller.abort();
let outputFailed = false;
// Stdout/stderr live for the process, including a late EPIPE after the last
// write callback. Cancel only this client and never print another error to it.
const outputFailure = () => { outputFailed = true; process.exitCode = 74; controller.abort(); };
process.stdout.on("error", outputFailure);
process.stderr.on("error", outputFailure);
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    createProductionDeps(controller.signal),
  );
  if (outputFailed) process.exitCode = 74;
} finally {
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
}
