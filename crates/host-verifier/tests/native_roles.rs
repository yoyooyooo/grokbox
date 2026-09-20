use grokbox_host_verifier::{analyze, CHECKS};
const NATIVE: &str = include_str!("../../../test/fixtures/host-verifier/sources/native-roles.cjs");
fn findings(text: &str) -> Vec<(String, String)> {
    let r = analyze(text, true, &CHECKS.iter().map(|(id,v)| ((*id).into(), *v)).collect::<Vec<_>>());
    assert!(r.valid, "variant must be valid JS; syntax rejection is not this oracle");
    r.findings.iter().map(|f| (f.state.into(), f.code.into())).collect()
}
#[test]
fn native_primary_summary_retry_and_class_method_are_distinct_roles() {
    let found = findings(NATIVE);
    assert!(found.iter().all(|(state,_)| state == "passed"), "{found:?}");
}
#[test]
fn native_optional_context_owner_preserves_the_exact_run_fallback() {
    let t = NATIVE.replacen("return { run };", "return { run: globalThis[Symbol.for('grokbox.box-runtime.context-control.v1')]?.wrapRun(host, run, () => false, reason => interrupt(reason)) ?? run };", 1);
    assert_eq!(findings(&t)[0].0,"passed", "{:?}", findings(&t));
}
#[test]
fn native_continuity_fence_keeps_the_same_native_run_and_arguments() {
    let text = NATIVE.replacen("async function run(prompt, options = {}) {", "async function run(prompt, options = {}) {\n const owner = globalThis[Symbol.for('grokbox.box-runtime.native-current-state.v1')];\n const selected = owner?.wrapRun(host, nativeRun) ?? nativeRun;\n return await selected(prompt, options);\n}\nasync function nativeRun(prompt, options = {}) {", 1);
    assert_eq!(findings(&text)[0].0,"passed", "{:?}", findings(&text));
    for mutated in [text.replace("?? nativeRun", "?? unrelated"),text.replace("wrapRun(host, nativeRun)","wrapRun(host, unrelated)"),text.replace("await selected(prompt, options)","await selected(prompt, other)")] {
        assert_ne!(findings(&mutated)[0].0,"passed");
    }
}
#[test]
fn checkpoint_metadata_writes_are_not_method_replacement() {
    let text = NATIVE.replace("const compact =", "stateHandler.lastStepInvocationId = 'public'; const compact =");
    assert_eq!(findings(&text)[2].0,"passed");
    for expression in ["stateHandler.computeNewStructure = foreign", "stateHandler[key] = foreign", "Object.assign(stateHandler, foreign)", "delete stateHandler.computeNewStructure"] {
        assert_ne!(findings(&NATIVE.replace("const compact =",&format!("{expression}; const compact =")))[2].0,"passed");
    }
}
#[test]
fn renaming_bindings_and_disjoint_conditional_spreads_preserve_local_meaning() {
    let renamed = NATIVE.replace("localOptions", "renamed").replace("options", "settings").replace("turn =", "request =").replace("invocationId: turn", "invocationId: request");
    let found = findings(&renamed);
    assert!(found.iter().all(|(state,_)| state == "passed"), "{found:?}");
}
#[test]
fn overwrites_aliases_and_foreign_turn_identity_cannot_be_hidden_by_auxiliary_sessions() {
    for (needle, replacement) in [
        ("...(options.lineage ? { lineage: options.lineage } : {})", "...options"),
        ("{ executorProfile: 'public' }", "{ agentId: 'foreign' }"),
        ("clientNonce: options.clientNonce", "clientNonce: foreign.clientNonce"),
        ("options.inferenceRequestId ?? crypto.randomUUID()", "options.unrelated ?? crypto.randomUUID()"),
        ("const session = await", "localOptions.agentId = 'foreign'; const session = await"),
        ("const session = await", "host.inference = foreign; const session = await"),
        ("const session = await", "options = foreign; const session = await"),
        ("const session = await", "unknownCode(localOptions); const session = await"),
        ("isSummarizationSession: true", "isSummarizationSession: false"),
        ("return { run };", "return { run: unrelated };"),
        ("async () => host.inference.createSession", "async () => false && host.inference.createSession"),
    ] {
        let mutated = NATIVE.replace(needle, replacement);
        assert_ne!(mutated, NATIVE);
        assert_ne!(findings(&mutated)[0].0, "passed", "mutation: {needle} -> {replacement}");
    }
}
#[test]
fn a_correct_exported_decoy_cannot_rescue_the_broken_native_main() {
    let changed = NATIVE.replace("clientNonce: options.clientNonce", "clientNonce: foreign.clientNonce");
    let decoy = include_str!("../../../test/fixtures/host-verifier/sources/qualified.cjs").split("function shouldRetryTurnAttempt").next().unwrap();
    let result = findings(&format!("{changed}\n{decoy}"));
    assert_ne!(result[0].0, "passed");
}
#[test]
fn retry_consumer_must_use_the_same_callback_and_caught_error() {
    for (needle, replacement) in [
        ("isRetryable: error =>", "isRetryable: foreign =>"),
        ("onRetry: () => {}", "...policy, onRetry: () => {}"),
        ("!isRetryable(error)", "!isRetryable(unrelated)"),
        ("!isRetryable(error)", "false"),
        ("return false;", "return true;"),
        ("return await bounded();", "return await once();"),
        ("if (count > 1 || !isRetryable(error)) throw error;", "if (count > 1 || isRetryable(error)) throw error;"),
    ] {
        let result = findings(&NATIVE.replace(needle, replacement));
        assert_ne!(result[1].0, "passed", "mutation: {needle} -> {replacement}: {result:?}");
    }
}
#[test]
fn trace_adapter_must_really_invoke_and_await_the_supplied_callback() {
    for text in [
        NATIVE.replace("await callback(ctx)", "42"),
        NATIVE.replace("await callback(ctx)", "callback(ctx)"),
        NATIVE.replace("callback(ctx)", "otherCallback(ctx)"),
        NATIVE.replace("if (!ctx) return await callback(ctx);", "if (!ctx) return null;"),
    ] { assert_ne!(findings(&text)[0].0, "passed"); }
}
#[test]
fn a_class_name_or_a_decoy_method_reference_is_not_a_checkpoint_role() {
    for (needle, replacement) in [
        ("this.runStep(ctx, state, save, executor)", "foreign.runStep(ctx, state, save, executor)"),
        ("return await this.runStep(ctx, state, save, executor);", "return 0; return await this.runStep(ctx, state, save, executor);"),
        ("return await this.runStep(ctx, state, save, executor);", "this.runStep = foreign; return await this.runStep(ctx, state, save, executor);"),
        ("return await this.runStep(ctx, state, save, executor);", "function decoy() { return this.runStep(ctx, state, save, executor); } return 0;"),
        ("return await this.runStep(ctx, state, save, executor);", "const decoy = () => this.runStep(ctx, state, save, executor); return 0;"),
        ("await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));", "onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));"),
    ] {
        let result = findings(&NATIVE.replace(needle, replacement));
        assert_ne!(result[2].0, "passed", "mutation: {needle} -> {replacement}: {result:?}");
    }
}
