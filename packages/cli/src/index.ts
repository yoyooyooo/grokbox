#!/usr/bin/env node
import { runCliEntry } from "./entry.ts";

await runCliEntry(process.argv.slice(2));
