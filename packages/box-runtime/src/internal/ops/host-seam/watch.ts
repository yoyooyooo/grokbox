import { observeHostProvenance, type HostSeamObserveReceipt } from "./observe.ts";

export type HostSeamWatchOnceReceipt = {
  process: "profile-watch";
  once: true;
  owned: 0;
  signaled: false;
  adopted: false;
  observe?: HostSeamObserveReceipt;
};

/** Bounded one-shot watch closeout. Long-running directory watch is not this slice. */
export async function watchHostSeamOnce(input: {
  root: string;
  from?: string;
  now?: () => string;
}): Promise<HostSeamWatchOnceReceipt> {
  const observe = input.from
    ? await observeHostProvenance({ root: input.root, from: input.from, now: input.now })
    : undefined;
  return {
    process: "profile-watch",
    once: true,
    owned: 0,
    signaled: false,
    adopted: false,
    ...(observe ? { observe } : {}),
  };
}
