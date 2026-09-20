use grokbox_host_verifier::analyze;
const GOOD: &str = include_str!("../../../test/fixtures/host-verifier/sources/lease-lifetime.cjs");
fn verdict(text: &str) -> (String, String) {
    let result = analyze(text,true,&[("context.lease-finally".into(),1)]);
    assert!(result.valid,"mutation must remain valid JS");
    (result.findings[0].state.into(),result.findings[0].code.into())
}
#[test] fn complete_local_lifetime() { assert_eq!(verdict(GOOD),("passed".into(),"sync-lease-protected-by-step-finally".into())); }
#[test] fn bindings_not_spellings() {
    for text in [GOOD.replace("const lease = compact", "const held = compact").replace("lease !=", "held !=").replace("lease[", "held[").replace("lease.preflight", "held.preflight"),
        GOOD.replace("let active = true", "let open = true").replace("!active", "!open").replace("active = false", "open = false"),
        GOOD.replace("addResource", "registerSync").replace("disposeResources", "settleSync"),format!("/* shifted 🐈 */\n{GOOD}")] {
        assert_eq!(verdict(&text).0,"passed");
    }
}
#[test] fn missing_finally_wrong_scope_and_early_release() {
    for (from,to) in [("finally {\n    disposeResources(env);", "finally {\n    void 0;"),
        ("disposeResources(env);", "disposeResources(other);"),
        ("result = rootPromptExecutor.executeToolStream", "disposeResources(env); result = rootPromptExecutor.executeToolStream"),
        ("addResource(env, slot, false);", "addResource(other, slot, false);"),
        ("addResource(env, slot, false);", "addResource(env, slot, true);")] {
        assert_ne!(verdict(&GOOD.replace(from,to)).0,"passed","{from}");
    }
}
#[test] fn preflight_must_be_after_registration_and_awaited() {
    for text in [GOOD.replace("await lease.preflight()","lease.preflight()"),
        GOOD.replace("addResource(env, slot, false);\n        if (typeof lease.preflight === \"function\") await lease.preflight();",
            "if (typeof lease.preflight === \"function\") await lease.preflight();\n        addResource(env, slot, false);"),
        GOOD.replace("await lease.preflight()","await other.preflight()"),
        GOOD.replace("lease != null","lease == null")] { assert_ne!(verdict(&text).0,"passed"); }
}
#[test] fn closure_must_close_before_original_sync_dispose() {
    for text in [GOOD.replace("active = false;", "active = true;"),GOOD.replace("stepClosed: () => !active", "stepClosed: () => active"),
        GOOD.replace("[Symbol.dispose]() {", "async [Symbol.dispose]() {"),
        GOOD.replace("lease[Symbol.dispose]();", "other[Symbol.dispose]();"),
        GOOD.replace("active = false;\n          lease[Symbol.dispose]();", "lease[Symbol.dispose]();\n          active = false;"),
        GOOD.replace("lease[Symbol.dispose]();", "try { lease[Symbol.dispose](); } catch {}") ] { assert_ne!(verdict(&text).0,"passed"); }
}
#[test] fn no_scope_mutation_or_alias_escape() {
    for text in [GOOD.replace("result = rootPromptExecutor", "env.stack.length = 0; result = rootPromptExecutor"),
        GOOD.replace("result = rootPromptExecutor", "unknownCode(env); result = rootPromptExecutor"),
        GOOD.replace("addResource(env, slot, false);", "unknownCode(slot); addResource(env, slot, false);"),
        GOOD.replace("const slot =", "unknownCode(lease); const slot ="),
        GOOD.replace("stepClosed: () => !active", "stepClosed: (active) => !active")] { assert_ne!(verdict(&text).0,"passed"); }
}
#[test] fn changed_disposal_abi_is_not_admitted_by_its_function_name() {
    for text in [GOOD.replace("scope.stack.push({ value, dispose });","return value;"),
        GOOD.replace("item.dispose.call(item.value);", "void item;"),
        GOOD.replace("if (failed) throw error;","if (failed) return;"),
        GOOD.replace("const disposeResources =", "const AggregateError = foreign; const disposeResources =")] {
        assert_eq!(verdict(&text).0,"unsupported");
    }
}
#[test] fn pending_provider_result_cannot_escape_the_finalizer_unawaited() {
    for text in [GOOD.replace("const response = await result.response;", "const response = result.response;"),
        GOOD.replace("const response = await result.response;", "if (skip) return result.response; const response = await result.response;"),
        GOOD.replace("const response = await result.response;", "const response = await other.response;"),
        GOOD.replace("const response = await result.response;", "result = other; const response = await result.response;") ] {
        assert_ne!(verdict(&text).0,"passed");
    }
}
#[test] fn provider_cannot_use_another_root_or_conditional_bypass() {
    for text in [GOOD.replace("result = rootPromptExecutor.executeToolStream", "result = other.executeToolStream"),
        GOOD.replace("const compact = globalThis", "if (shouldAcquire) { const compact = globalThis").replace("    result = rootPromptExecutor", "    }\n    result = rootPromptExecutor"),
        GOOD.replace("result = rootPromptExecutor.executeToolStream(ctx);", "result = rootPromptExecutor.executeToolStream(ctx);\n    env.hasError = false;") ] {
        assert_ne!(verdict(&text).0,"passed");
    }
}
