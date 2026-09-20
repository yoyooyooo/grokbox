//! Local synchronous resource lifetime. The disposal ABI is a separately
//! qualified dependency, not a function-name guess or an AST parse success.
//! This does not prove heap aliases or physical cancellation of remote work.
use super::*;
use sha2::{Digest, Sha256};
use oxc_syntax::operator::AssignmentOperator;

type Verdict = (&'static str, &'static str, Span);
const ADD_ABIS: &[&str] = &[
    // Installed native helper; exercised by native-disposal-qualification.
    "6b765884eb79ed9a26a3d4a190fddb0592faa7028ea5ff7c90422f9b2157c532",
    // Independently authored public synchronous helper, exercised separately.
    "94b4d9224f08a82f100c4a57e2911159daddb0f70dcff1739daa1ac98f196f00",
];
const DISPOSE_ABIS: &[&str] = &[
    "072532d1842c670a1e86533f8ec1d3a6470e3311641771bc0cefd1f9ed6ea93c",
    "9c1b3d106e0889cdc3e7b6cb402f9ce7ecb4a68416583e2c210f4b73e6436edc",
];
fn ident(i: &IdentifierReference<'_>, s: &Semantic<'_>) -> Option<SymbolId> {
    i.reference_id.get().and_then(|r| s.scoping().get_reference(r).symbol_id())
}
fn id(d: &VariableDeclarator<'_>) -> Option<SymbolId> {
    match &d.id.kind { BindingPatternKind::BindingIdentifier(i) => i.symbol_id.get(), _ => None }
}
fn declaration<'a,'b>(stmt: &'b Statement<'a>, kind: VariableDeclarationKind) -> Option<&'b VariableDeclarator<'a>> {
    let Statement::VariableDeclaration(v) = stmt else { return None; };
    (v.kind == kind && v.declarations.len() == 1).then(|| &v.declarations[0])
}
fn expression<'a, 'b>(stmt: &'b Statement<'a>) -> Option<&'b Expression<'a>> {
    if let Statement::ExpressionStatement(e) = stmt { Some(&e.expression) } else { None }
}
fn disposable(e: &Expression<'_>, s: &Semantic<'_>) -> bool {
    member(e,"dispose").is_some_and(|e| global(e,"Symbol",s))
}
fn presence(e: &Expression<'_>, expected: SymbolId, s: &Semantic<'_>) -> bool {
    let Expression::BinaryExpression(eq) = e.get_inner_expression() else { return false; };
    let Expression::UnaryExpression(ty) = eq.left.get_inner_expression() else { return false; };
    eq.operator == BinaryOperator::StrictEquality && ty.operator == UnaryOperator::Typeof
        && binding(&ty.argument,s) == Some(expected)
        && matches!(eq.right.get_inner_expression(),Expression::StringLiteral(v) if v.value == "function")
}
fn helper(e: &Expression<'_>, s: &Semantic<'_>, source: &str, hashes: &[&str]) -> bool {
    if !unmodified(e,s) { return false; }
    let Some(symbol) = binding(e,s) else { return false; };
    let AstKind::VariableDeclarator(d) = s.symbol_declaration(symbol).kind() else { return false; };
    // Include the exact initializer and any emitter annotation; bound names of
    // the helper itself are irrelevant. A changed helper needs its own review.
    let Some(text) = source.get(d.span.start as usize..d.span.end as usize).and_then(|t|t.split_once('=').map(|(_,v)|v.trim())) else { return false; };
    let digest = format!("{:x}",Sha256::digest(text.as_bytes()));
    if !hashes.contains(&digest.as_str()) { return false; }
    // A same-spelled, lexically shadowed built-in invalidates this ABI proof.
    s.nodes().iter().all(|n| match n.kind() {
        AstKind::IdentifierReference(i) if d.span.contains_inclusive(i.span)
            && ["Symbol","Promise","Error","TypeError","AggregateError","SuppressedError"].contains(&i.name.as_str()) => ident(i,s).is_none(),
        _ => true,
    })
}
fn same_frame(s: &Semantic<'_>, node: NodeId, owner: NodeId) -> bool {
    s.nodes().ancestors(node).find(|n| matches!(n.kind(),AstKind::Function(_)|AstKind::ArrowFunctionExpression(_))).map(|n|n.id()) == Some(owner)
}
fn unconditional(s: &Semantic<'_>, node: NodeId, owner: NodeId) -> bool {
    for n in s.nodes().ancestors(node).skip(1) {
        if n.id() == owner { return true; }
        if matches!(n.kind(),AstKind::IfStatement(_)|AstKind::ConditionalExpression(_)|AstKind::LogicalExpression(_)
            |AstKind::ForStatement(_)|AstKind::WhileStatement(_)|AstKind::ForOfStatement(_)|AstKind::ForInStatement(_)
            |AstKind::DoWhileStatement(_)|AstKind::SwitchStatement(_)|AstKind::ArrowFunctionExpression(_)|AstKind::Function(_)) { return false; }
        if let AstKind::TryStatement(t) = n.kind() {
            let at = s.nodes().kind(node).span();
            if !t.block.span.contains_inclusive(at) { return false; }
        }
    }
    false
}

pub(super) fn check(s: &Semantic<'_>, source: &str) -> Verdict {
    let calls: Vec<_> = s.nodes().iter().filter_map(|n| match n.kind() {
        AstKind::CallExpression(c) if initializer(&c.callee,s).is_some_and(|v|hook(v,"grokbox.box-runtime.host-compact.v1",s)) => Some((c,n.id())), _ => None,
    }).collect();
    if calls.len() != 1 { return ("unsupported","compact-hook-not-unique",Span::default()); }
    let (invoke,node) = calls[0];
    let bad = |code| ("violated",code,invoke.span);
    if !unmodified(&invoke.callee,s) || !(exposed_owner(s,node) || native_roles::checkpoint_owner(s,node)) {
        return ("unsupported","lease-role-unproven",invoke.span);
    }
    let Some(function_node) = s.nodes().ancestors(node).find(|n|matches!(n.kind(),AstKind::Function(_))) else { return bad("lease-owner-missing"); };
    let AstKind::Function(function) = function_node.kind() else { unreachable!() };
    if !function.r#async || function.generator { return bad("lease-owner-not-async"); }
    let Some(body) = &function.body else { return bad("lease-owner-missing"); };
    if body.statements.len() != 2 { return ("unsupported","lease-outer-shape",function.span); }
    let Some(env_decl) = declaration(&body.statements[0],VariableDeclarationKind::Const) else { return bad("resource-scope-not-constant"); };
    let Some(env) = id(env_decl) else { return bad("resource-scope-not-constant"); };
    let Some(Expression::ObjectExpression(env_init)) = env_decl.init.as_ref() else { return bad("resource-scope-not-empty"); };
    let Some(env_fields) = fields(env_init) else { return bad("resource-scope-not-empty"); };
    if env_fields.len()!=3 || !env_fields.iter().any(|(k,v)|*k=="stack" && matches!(v,Expression::ArrayExpression(a) if a.elements.is_empty()))
        || !env_fields.iter().any(|(k,v)|*k=="error" && matches!(v,Expression::UnaryExpression(e) if e.operator==UnaryOperator::Void && matches!(&e.argument,Expression::NumericLiteral(n) if n.value==0.0)))
        || !env_fields.iter().any(|(k,v)|*k=="hasError" && matches!(v,Expression::BooleanLiteral(b) if !b.value)) { return bad("resource-scope-not-empty"); }
    let Statement::TryStatement(outer) = &body.statements[1] else { return bad("lease-finally-missing"); };
    if !outer.block.span.contains_inclusive(invoke.span) { return bad("lease-outside-protected-body"); }
    let Some(finalizer) = &outer.finalizer else { return bad("lease-finally-missing"); };
    if finalizer.body.len()!=1 { return bad("lease-finally-not-exact"); }
    let Some(cleanup) = expression(&finalizer.body[0]).and_then(call) else { return bad("lease-finally-not-exact"); };
    if cleanup.arguments.len()!=1 || cleanup.arguments[0].as_expression().and_then(|e|binding(e,s))!=Some(env) { return bad("lease-finally-wrong-scope"); }
    if !helper(&cleanup.callee,s,source,DISPOSE_ABIS) { return ("unsupported","disposal-helper-unqualified",cleanup.span); }

    let Some(guard_node) = s.nodes().ancestors(node).find(|n|matches!(n.kind(),AstKind::IfStatement(_))) else { return bad("lease-presence-guard-missing"); };
    let AstKind::IfStatement(guard) = guard_node.kind() else { unreachable!() };
    if guard.alternate.is_some() || !presence(&guard.test,binding(&invoke.callee,s).unwrap(),s) { return bad("lease-presence-guard-invalid"); }
    let Statement::BlockStatement(block) = &guard.consequent else { return bad("lease-body-invalid"); };
    if block.body.len()!=3 { return bad("lease-body-invalid"); }
    let Some(active_decl) = declaration(&block.body[0],VariableDeclarationKind::Let) else { return bad("lease-active-initializer"); };
    let Some(active) = id(active_decl) else { return bad("lease-active-initializer"); };
    if !matches!(active_decl.init.as_ref(),Some(Expression::BooleanLiteral(b)) if b.value) { return bad("lease-active-initializer"); }
    let Some(lease_decl) = declaration(&block.body[1],VariableDeclarationKind::Const) else { return bad("lease-not-retained"); };
    let Some(lease) = id(lease_decl) else { return bad("lease-not-retained"); };
    if lease_decl.init.as_ref().map(GetSpan::span)!=Some(invoke.span) || invoke.arguments.len()!=1 { return bad("lease-not-retained"); }
    let Some(Expression::ObjectExpression(options)) = invoke.arguments[0].as_expression() else { return bad("lease-callback-missing"); };
    let Some(options) = fields(options) else { return bad("lease-callback-missing"); };
    let Some((_,Expression::ArrowFunctionExpression(closed))) = options.iter().find(|(k,_)|*k=="stepClosed") else { return bad("lease-callback-missing"); };
    if closed.r#async || !closed.expression || !closed.params.items.is_empty() || closed.params.rest.is_some() || closed.body.statements.len()!=1 { return bad("lease-callback-invalid"); }
    if !matches!(expression(&closed.body.statements[0]),Some(Expression::UnaryExpression(e)) if e.operator==UnaryOperator::LogicalNot && binding(&e.argument,s)==Some(active)) { return bad("lease-callback-wrong-binding"); }
    let Statement::IfStatement(nonnull) = &block.body[2] else { return bad("lease-null-guard-invalid"); };
    if nonnull.alternate.is_some() || !matches!(nonnull.test.get_inner_expression(),Expression::BinaryExpression(e) if e.operator==BinaryOperator::Inequality && binding(&e.left,s)==Some(lease) && matches!(e.right.get_inner_expression(),Expression::NullLiteral(_))) { return bad("lease-null-guard-invalid"); }
    let Statement::BlockStatement(acquired) = &nonnull.consequent else { return bad("lease-registration-missing"); };
    if acquired.body.len()!=3 { return bad("lease-registration-order"); }
    let Some(slot_decl) = declaration(&acquired.body[0],VariableDeclarationKind::Const) else { return bad("lease-disposer-invalid"); };
    let Some(slot) = id(slot_decl) else { return bad("lease-disposer-invalid"); };
    let Some(Expression::ObjectExpression(slot_init)) = slot_decl.init.as_ref() else { return bad("lease-disposer-invalid"); };
    if slot_init.properties.len()!=1 { return bad("lease-disposer-invalid"); }
    let ObjectPropertyKind::ObjectProperty(property) = &slot_init.properties[0] else { return bad("lease-disposer-invalid"); };
    if !property.method || !property.computed || property.kind!=PropertyKind::Init || !property.key.as_expression().is_some_and(|e|disposable(e,s)) { return bad("lease-disposer-invalid"); }
    let Expression::FunctionExpression(dispose) = &property.value else { return bad("lease-disposer-invalid"); };
    let Some(dispose_body) = &dispose.body else { return bad("lease-disposer-invalid"); };
    if dispose.r#async || dispose.generator || !dispose.params.items.is_empty() || dispose.params.rest.is_some() || dispose_body.statements.len()!=2 { return bad("lease-disposer-not-sync"); }
    if !matches!(expression(&dispose_body.statements[0]),Some(Expression::AssignmentExpression(a)) if a.operator==AssignmentOperator::Assign && matches!(&a.left,AssignmentTarget::AssignmentTargetIdentifier(i) if ident(i,s)==Some(active)) && matches!(&a.right,Expression::BooleanLiteral(b) if !b.value)) { return bad("lease-not-closed-before-dispose"); }
    let Some(release) = expression(&dispose_body.statements[1]).and_then(call) else { return bad("lease-dispose-not-called"); };
    if !release.arguments.is_empty() || !matches!(release.callee.get_inner_expression(),Expression::ComputedMemberExpression(m) if !m.optional && binding(&m.object,s)==Some(lease) && disposable(&m.expression,s)) { return bad("lease-dispose-wrong-binding"); }
    let Some(add) = expression(&acquired.body[1]).and_then(call) else { return bad("lease-registration-missing"); };
    if add.arguments.len()!=3 || add.arguments[0].as_expression().and_then(|e|binding(e,s))!=Some(env)
        || add.arguments[1].as_expression().and_then(|e|binding(e,s))!=Some(slot)
        || !matches!(add.arguments[2].as_expression(),Some(Expression::BooleanLiteral(b)) if !b.value) { return bad("lease-registration-wrong-scope"); }
    if !helper(&add.callee,s,source,ADD_ABIS) { return ("unsupported","registration-helper-unqualified",add.span); }
    let Statement::IfStatement(preflight) = &acquired.body[2] else { return bad("lease-preflight-not-awaited"); };
    if preflight.alternate.is_some() { return bad("lease-preflight-not-awaited"); }
    let Expression::BinaryExpression(eq) = &preflight.test else { return bad("lease-preflight-not-awaited"); };
    if eq.operator!=BinaryOperator::StrictEquality || !matches!(&eq.left,Expression::UnaryExpression(u) if u.operator==UnaryOperator::Typeof && member(&u.argument,"preflight").and_then(|e|binding(e,s))==Some(lease))
        || !matches!(&eq.right,Expression::StringLiteral(v) if v.value=="function") { return bad("lease-preflight-not-awaited"); }
    let Some(Statement::ExpressionStatement(statement)) = one_statement(&preflight.consequent) else { return bad("lease-preflight-not-awaited"); };
    let Expression::AwaitExpression(awaited) = &statement.expression else { return bad("lease-preflight-not-awaited"); };
    if !call(&awaited.argument).is_some_and(|c|c.arguments.is_empty() && member(&c.callee,"preflight").and_then(|e|binding(e,s))==Some(lease)) { return bad("lease-preflight-wrong-binding"); }
    // No alias escapes, reassignments or early release via these private slots.
    for (symbol,expected,allowed) in [(active,2,vec![closed.span,dispose.span]),(lease,4,vec![nonnull.test.span(),dispose.span,preflight.span]),(slot,1,vec![add.span])] {
        let refs: Vec<_> = s.scoping().get_resolved_references(symbol).collect();
        if refs.len()!=expected || refs.iter().any(|r| !allowed.iter().any(|range|range.contains_inclusive(s.nodes().kind(r.node_id()).span()))) { return bad("lease-private-binding-escaped"); }
    }
    let Some((_,root)) = options.iter().find(|(k,_)|*k=="rootPromptExecutor") else { return bad("lease-provider-binding-missing"); };
    let Some(parent_block) = s.nodes().parent_node(guard_node.id()) else { return bad("lease-provider-not-adjacent"); };
    let (siblings,block_span) = match parent_block.kind() {
        AstKind::BlockStatement(b)=>(b.body.as_slice(),b.span), _=>return bad("lease-provider-not-adjacent"),
    };
    let Some(position) = siblings.iter().position(|st|st.span()==guard.span) else { return bad("lease-provider-not-adjacent"); };
    let Some(Statement::ExpressionStatement(provider)) = siblings.get(position+1) else { return bad("lease-provider-not-adjacent"); };
    let Expression::AssignmentExpression(assignment) = &provider.expression else { return bad("lease-provider-not-adjacent"); };
    let Some(provider_call) = call(&assignment.right) else { return bad("lease-provider-not-adjacent"); };
    if !member(&provider_call.callee,"executeToolStream").is_some_and(|e|same(e,root,s)) || !outer.block.span.contains_inclusive(block_span) { return bad("lease-provider-wrong-binding"); }
    if !unconditional(s,guard_node.id(),function_node.id()) { return ("unsupported","lease-branch-unproven",guard.span); }
    let AssignmentTarget::AssignmentTargetIdentifier(result_name) = &assignment.left else { return bad("lease-result-not-bound"); };
    let Some(result_id) = ident(result_name,s) else { return bad("lease-result-not-bound"); };
    if s.scoping().get_resolved_references(result_id).filter(|r|r.is_write()).any(|r|!assignment.left.span().contains_inclusive(s.nodes().kind(r.node_id()).span())) { return bad("lease-result-replaced"); }
    let waits: Vec<_> = s.nodes().iter().filter_map(|n| {
        let AstKind::AwaitExpression(a) = n.kind() else { return None; };
        if !same_frame(s,n.id(),function_node.id()) || !outer.block.span.contains_inclusive(a.span) || !unconditional(s,n.id(),function_node.id()) { return None; }
        let response = |e:&Expression<'_>| member(e,"response").and_then(|e|binding(e,s))==Some(result_id);
        let joined = call(&a.argument).is_some_and(|c|c.arguments.len()==1 && member(&c.callee,"all").is_some_and(|e|global(e,"Promise",s))
            && matches!(c.arguments[0].as_expression(),Some(Expression::ArrayExpression(values)) if values.elements.iter().any(|v|v.as_expression().is_some_and(response))));
        (response(&a.argument)||joined).then_some(a.span)
    }).collect();
    if waits.len()!=1 || waits[0].start<provider.span.end { return bad("lease-result-not-awaited"); }
    if s.nodes().iter().any(|n|matches!(n.kind(),AstKind::ReturnStatement(r) if r.span.start<waits[0].end && same_frame(s,n.id(),function_node.id()))) { return bad("lease-result-escapes-before-settlement"); }
    // The environment is only passed to the same synchronous registration ABI,
    // settled in its original catch, and consumed once by its finalizer.
    for reference in s.scoping().get_resolved_references(env) {
        let at = s.nodes().kind(reference.node_id()).span();
        if cleanup.span.contains_inclusive(at) { continue; }
        if let Some(parent) = s.nodes().ancestors(reference.node_id()).skip(1).find(|n| !matches!(n.kind(),AstKind::Argument(_)|AstKind::ParenthesizedExpression(_))) {
            if let AstKind::CallExpression(c) = parent.kind() {
                if same(&c.callee,&add.callee,s) && c.arguments.len()==3 && c.arguments[0].span()==at
                    && matches!(c.arguments[2].as_expression(),Some(Expression::BooleanLiteral(b)) if !b.value)
                    && outer.block.span.contains_inclusive(c.span) && same_frame(s,parent.id(),function_node.id()) { continue; }
            }
        }
        let assignment = s.nodes().ancestors(reference.node_id()).find_map(|n|if let AstKind::AssignmentExpression(a)=n.kind(){Some(a)}else{None});
        if let (Some(catch),Some(a)) = (&outer.handler,assignment) {
            if catch.body.span.contains_inclusive(a.span) && a.operator==AssignmentOperator::Assign
                && matches!(&a.left,AssignmentTarget::StaticMemberExpression(m) if binding(&m.object,s)==Some(env) && ["error","hasError"].contains(&m.property.name.as_str())) { continue; }
        }
        return bad("resource-scope-mutated-or-escaped");
    }
    ("passed","sync-lease-protected-by-step-finally",outer.span)
}
