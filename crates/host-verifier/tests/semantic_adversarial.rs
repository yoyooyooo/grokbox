use grokbox_host_verifier::{analyze, CHECKS};
const GOOD: &str = include_str!("../../../test/fixtures/host-verifier/sources/qualified.cjs");
fn not_passed(text: String, index: usize) {
    let result = analyze(&text, true, &CHECKS.iter().map(|(id, rev)| ((*id).into(), *rev)).collect::<Vec<_>>());
    assert_ne!(result.findings[index].state, "passed", "{} admitted a broken independent variant", CHECKS[index].0);
}
#[test]
fn unreachable_main_call_is_not_a_binding_proof() {
    for text in [
        GOOD.replace("return host.inference", "return null; return host.inference"),
        GOOD.replace("return host.inference.createSession(emit, mainOptions);", "if (false) return host.inference.createSession(emit, mainOptions);"),
        GOOD.replace("function main(host, options, turnId, emit) {", "function main(host, options, turnId, emit) { if (false) {").replacen("\n}\n", "\n}}\n", 1),
    ] { not_passed(text, 0); }
}
#[test]
fn tdz_values_cannot_supply_main_identity() {
    not_passed(GOOD.replace("function main(host, options, turnId, emit)", "function main(host, options, unused, emit)")
        .replace("return host.inference.createSession(emit, mainOptions);", "return host.inference.createSession(emit, mainOptions); const turnId = unused;"), 0);
}
#[test]
fn replaced_or_unreachable_checkpoint_hook_does_not_pass() {
    for text in [
        GOOD.replace("const compact =", "let compact =").replace("return compact({", "compact = () => null; return compact({"),
        GOOD.replace("return compact({", "return null; return compact({"),
        GOOD.replace("return compact({", "if (false) return compact({"),
        GOOD.replace("return compact({", "stateHandler = foreign; return compact({"),
        GOOD.replace("return compact({", "stateHandler.computeNewStructure = foreign; return compact({"),
        GOOD.replace("return compact({", "onStateUpdate = foreign; return compact({"),
    ] { not_passed(text, 2); }
}
#[test]
fn object_receiver_overwrite_and_foreign_closure_identity_are_not_main_binding() {
    not_passed(GOOD.replace("return host.inference", "host.inference = foreign; return host.inference"),0);
    not_passed(format!("const turnId = foreign;\n{}",GOOD.replace("function main(host, options, turnId, emit)","function main(host, options, unused, emit)")),0);
}
#[test]
fn unregistered_or_overwritten_entrypoints_cannot_supply_role_proof() {
    for text in [GOOD.replace("module.exports = { main, shouldRetryTurnAttempt, step };", ""),
        format!("{GOOD}\nmodule.exports = {{}};")] {
        for index in 0..3 { not_passed(text.clone(),index); }
    }
}
#[test]
fn dead_retry_function_is_not_an_operational_guard() {
    not_passed(GOOD.replace("function shouldRetryTurnAttempt(input) {", "if (false) { function shouldRetryTurnAttempt(input) {")
        .replace("async function step", "}\nasync function step"), 1);
}
