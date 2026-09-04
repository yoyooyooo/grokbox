#!/usr/bin/env node
import { createProductionDeps } from "./deps.ts";
import { runCli } from "./program.ts";

const controller = new AbortController();
const abort = () => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    createProductionDeps(controller.signal),
  );
} finally {
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
}
