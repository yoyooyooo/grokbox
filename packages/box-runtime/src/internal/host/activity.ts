import { HOST_ACTIVITY_SYMBOL } from "./profile.ts";

export { HOST_ACTIVITY_SYMBOL };

export type HostActivityUpdate = {
  type: "thinking-delta" | "text-delta";
  text: string;
};

/** Host UI only. Missing sink or throw must not affect inference. */
export function emitHostActivity(update: HostActivityUpdate): void {
  const emit = (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
  if (typeof emit !== "function") return;
  try {
    emit(update);
  } catch {
    /* Host activity is not a model effect. */
  }
}
