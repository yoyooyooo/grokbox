use grokbox_host_verifier::{analyze,CHECKS};
const GOOD:&str=include_str!("../../../test/fixtures/host-verifier/sources/qualified.cjs");
fn run(text:&str)->grokbox_host_verifier::Analysis{analyze(text,true,&CHECKS.iter().map(|(id,v)|((*id).into(),*v)).collect::<Vec<_>>())}
#[test]fn independent_positive(){let r=run(GOOD);assert!(r.valid);assert!(r.findings.iter().all(|f|f.state=="passed"));}
#[test]fn lexical_renaming_and_comments_preserve_supported_meaning(){let text=GOOD.replace("mainOptions","renamedOptions").replace("failed","isManagedFailure").replace("turnId","renamedTurn");assert!(run(&format!("/* shifted 🐈 */\n{text}")).findings.iter().all(|f|f.state=="passed"));}
#[test]fn false_branch_is_not_a_guard(){for replacement in ["return true;","throw input.error;"]{let r=run(&GOOD.replace("return false;",replacement));assert_eq!(r.findings[1].state,"violated");}}
#[test]fn wrong_catch_input_and_global_shadowing_are_not_binding_proofs(){for text in [GOOD.replace("failed(input.error)","failed({ error: input.error })"),GOOD.replace("function shouldRetryTurnAttempt(input)","function shouldRetryTurnAttempt(input, globalThis)"),GOOD.replace("const failed = globalThis", "const failed = otherGlobal")]{assert_ne!(run(&text).findings[1].state,"passed");}}
#[test]fn reassignment_spread_duplicate_and_alias_do_not_pass(){for text in [
 GOOD.replace("return host.inference", "mainOptions.agentId = 'foreign'; return host.inference"),
 GOOD.replace("const mainOptions =", "let mainOptions =").replace("return host.inference", "mainOptions = {}; return host.inference"),
 GOOD.replace("agentId: host.getConversationId()", "...options, agentId: host.getConversationId()"),
 GOOD.replace("clientNonce: options.clientNonce", "agentId: 'foreign', clientNonce: options.clientNonce"),
 GOOD.replace("return host.inference", "unknownCode(mainOptions); return host.inference"),
 GOOD.replace("agentId: host.getConversationId()", "agentId: foreign.getConversationId()")]{assert_ne!(run(&text).findings[0].state,"passed");}}
#[test]fn same_name_in_another_scope_cannot_supply_options(){let t=GOOD.replace("  const mainOptions =", "  { const mainOptions =").replace("  return host.inference", "  }\n  return host.inference");assert_ne!(run(&t).findings[0].state,"passed");}
#[test]fn checkpoint_must_await_both_production_and_persistence_in_the_same_binding(){for text in [
 GOOD.replace("await onStateUpdate", "onStateUpdate"),GOOD.replace("await stateHandler", "stateHandler"),
 GOOD.replace("onStateUpdate(ctx,", "onStateUpdate(foreign, "),GOOD.replace("computeNewStructure(ctx)","computeNewStructure(foreign)"),
 GOOD.replace("contextCheckpoint: async ()", "contextCheckpoint: async (ctx)"),
 GOOD.replace("throw new Error(\"checkpoint_unavailable\")", "return false"),
 GOOD.replace("await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx));", "await onStateUpdate(ctx, await stateHandler.computeNewStructure(ctx)); onStateUpdate(ctx, {});")]{assert_ne!(run(&text).findings[2].state,"passed");}}
#[test]fn reassigned_compact_hook_or_checkpoint_inputs_do_not_prove_the_original_lifetime(){for text in [
 GOOD.replace("const compact =", "let compact =").replace("return compact({", "compact = unrelated; return compact({"),
 GOOD.replace("return compact({", "stateHandler = foreign; return compact({"),
 GOOD.replace("return compact({", "onStateUpdate = foreign; return compact({"),
 GOOD.replace("return compact({", "ctx = foreign; return compact({")]{assert_ne!(run(&text).findings[2].state,"passed");}}
#[test]fn recovered_ast_is_not_valid_syntax(){for text in ["const x = ;", "let x = 1; let x = 2;", "function f(){'use strict'; const x = 1; delete x;}"]{assert!(!run(text).valid);}}
#[test]fn unsupported_revision_is_explicit(){let r=analyze(GOOD,true,&[("session.main-binding".into(),2)]);assert_eq!(r.findings[0].code,"checker-not-implemented");}
#[test]fn source_parse_never_emits_candidate_rule_success(){let r=analyze("const a = ;",false,&[("session.main-binding".into(),1)]);assert!(!r.valid);assert!(r.findings.is_empty());}
