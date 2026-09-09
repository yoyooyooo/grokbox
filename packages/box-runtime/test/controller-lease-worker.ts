import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { admitControllerRequest } from "@grokbox/runtime-kernel/commands";
import { ControlResources } from "@grokbox/runtime-kernel/ports";
import { liveControlResourcesLayer } from "../src/internal/roots/controller-program.node.ts";

const boxRoot = process.argv[2];
const outPath = process.argv[3];
const command = admitControllerRequest({
  intent: "apply",
  confirmed: true,
  operationId: "op-cross",
  boxRoot,
  strategy: "direct",
});
if (!command || !outPath) {
  writeFileSync(outPath ?? "/dev/stderr", JSON.stringify({ status: "invalid" }));
  process.exit(2);
}

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* ControlResources;
      const decision = yield* control.lease(command);
      writeFileSync(outPath, `${JSON.stringify(decision)}\n`);
      yield* Effect.never;
    }).pipe(Effect.provide(liveControlResourcesLayer())),
  ),
);
