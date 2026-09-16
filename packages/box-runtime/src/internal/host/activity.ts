import { HOST_ACTIVITY_SYMBOL } from "./profile.ts";

export { HOST_ACTIVITY_SYMBOL };

export type HostActivityUpdate = {
  type: "thinking-delta" | "text-delta";
  text: string;
};

/** Only an explicitly owned callback may be used. A process-global 'last
 * listener' routes A's update into B's UI/watchdog. Synthetic first-chunk
 * pulses no longer use this helper; native interaction listeners own activity. */
export function emitHostActivity(update: HostActivityUpdate, emit?: (update: HostActivityUpdate) => void): void {
  if (typeof emit !== "function") return;
  try {
    emit(update);
  } catch {
    /* Host activity is not a model effect. */
  }
}
