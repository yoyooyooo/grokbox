import { Effect, Stream } from "effect";
import { BindingFailure } from "../contract/binding.ts";
import type { InferenceEvent } from "../contract/events.ts";

/** Drop further chunks/success after cancel. Does not invent Host finish.response. */
export function fenceStream<E, R>(
  stream: Stream.Stream<InferenceEvent, E, R>,
  cancelled: Effect.Effect<boolean>,
): Stream.Stream<InferenceEvent, E | BindingFailure, R> {
  return Stream.mapEffect(stream, (event) => Effect.gen(function* () {
    if (yield* cancelled) return yield* Effect.fail(new BindingFailure("cancelled"));
    return event;
  }));
}
