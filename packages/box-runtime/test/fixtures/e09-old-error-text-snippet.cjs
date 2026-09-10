// Owned old-dist oracle. Not a session factory. Error was yielded as assistant text-delta.
function visibleFailureHandle(message) {
  return {
    fullStream: {
      async *[Symbol.asyncIterator]() {
        yield { type: "text-delta", textDelta: message };
      },
    },
  };
}
module.exports = { visibleFailureHandle };
