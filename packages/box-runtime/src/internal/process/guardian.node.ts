import { identitiesMatch, signalIfMatch, type ProcessIdentity, type ProcessPort } from "./process-port.ts";

export type Guardian = {
  close: () => void;
  crashInjector: () => void;
  released: () => boolean;
};

export function armGuardian(input: {
  wrapper: ProcessIdentity;
  processes: ProcessPort;
  deadlineMs: number;
  now: () => number;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}): Guardian {
  const controller = new AbortController();
  let released = false;
  const cont = () => {
    if (released) return;
    released = true;
    const observed = input.processes.inspect(input.wrapper.pid);
    if (!identitiesMatch(input.wrapper, observed)) return;
    signalIfMatch(input.processes, input.wrapper, "SIGCONT");
  };

  const deadline = input.now() + input.deadlineMs;
  void (async () => {
    const remaining = Math.max(1, deadline - input.now());
    await input.wait(remaining, controller.signal);
    cont();
  })();

  return {
    close: () => {
      controller.abort();
      cont();
    },
    crashInjector: () => {
      controller.abort();
      cont();
    },
    released: () => released,
  };
}
