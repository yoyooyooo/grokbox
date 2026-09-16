// Owned Node child for the packaged Host/client integration test. The only
// startup module is the actual dist/preload.cjs behind its explicit test fence.
// It does not start an official Host or read real profile/credential files.
const factory = globalThis[Symbol.for('grokbox.box-runtime.packed-session.v1')];
if (!factory || typeof factory.bindHostSessionHook !== 'function' || typeof factory.bindHostOwnershipRead !== 'function') {
  process.stderr.write('packed_ownership_factory_missing\n');
  process.exit(2);
}
let config;
let nativeReads = 0;
let officialEffects = 0;
let executionReads = 0;
const readOwnership = factory.bindHostOwnershipRead();
const original = { getExecutor() { officialEffects++; throw new Error('official_execution_forbidden'); } };
process.on('message', async message => {
  if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
  try {
    let value;
    if (message.method === 'init') {
      config = message.input;
      value = { ready: true, pid: process.pid };
    } else if ((message.method === 'ownership' || message.method === 'ownership-local') && config) {
      const localOnly = message.method === 'ownership-local';
      const snapshot = await readOwnership({
        agentIds: message.input, localOnly,
        readScope: () => ({ backend: 'https://owned.invalid', account: 'a'.repeat(64), team: null, machine: 'owned-machine' }),
        readWindow: () => ({ kind: 'inactive' }),
        readExecution: () => {
          executionReads++;
          if (config.executionState === 'unavailable') throw new Error('PRIVATE_NATIVE_STATE');
          return { allowed: config.executionState !== 'paused', bound: config.executionState !== 'unbound' };
        },
        readLocal: () => ({ serverId: 'owned-server-row', harness: 'box' }),
        listServer: async () => {
          nativeReads++;
          return { agents: [{ agentId: config.agentId, id: 'owned-server-row', harness: config.serverHarness, viewerIsOwner: true }] };
        },
      });
      if (config.legacyEvidence && !localOnly) snapshot.schemaVersion = 2;
      value = { snapshot, gateway: { pid: process.pid, startedAt: 1 } };
    } else if (message.method === 'run' && config) {
      const hook = factory.bindHostSessionHook({ mode: 'route', durableRoot: config.durableRoot,
        runRoot: config.runRoot, binding: config.binding, compile: config.compile });
      const session = hook({ originalSession: original, agentId: config.agentId,
        sessionOptions: { invocationId: config.turnId } });
      if (!session || typeof session.getExecutor !== 'function' || session === original) throw new Error('packed_session_not_managed');
      const executor = session.getExecutor([
        { role: 'system', content: 'Owned system root.' },
        { role: 'user', content: 'Return the fixture answer.' },
      ]);
      const handle = executor.stream({}, config.stepId);
      const response = await handle.response;
      value = { finishReason: response.finishReason, modelId: response.modelId, messages: response.messages };
    } else if (message.method === 'counts') {
      value = { nativeReads, officialEffects, executionReads };
    } else if (message.method === 'stop') {
      process.send({ id: message.id, ok: true, value: null }, () => { process.disconnect(); process.exit(0); });
      return;
    } else throw new Error('unsupported_owned_message');
    process.send({ id: message.id, ok: true, value });
  } catch (error) {
    process.send({ id: message.id, ok: false, error: {
      code: typeof error?.code === 'string' ? error.code : 'owned_client_error',
      name: typeof error?.name === 'string' ? error.name : 'Error',
      managed: factory.isHostManagedFailure(error),
    } });
  }
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready' });
