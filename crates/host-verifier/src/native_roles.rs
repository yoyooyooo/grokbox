//! Finite native-role recognition, separate from runtime reachability.
//!
//! A role is selected from its lexical owner and consumed callback/returned
//! member, never by taking the first matching options object in a bundle.
//! These predicates prove local wiring only. The runtime witness must still
//! establish that this generation registered and exercised the native path.
use super::*;
use std::collections::HashSet;

pub(super) fn function<'a>(s: &Semantic<'a>, name: &str) -> Option<(&'a Function<'a>, NodeId)> {
    let mut found = s.nodes().iter().filter_map(|node| match node.kind() {
        AstKind::Function(f) if f.id.as_ref().is_some_and(|id| id.name == name) => Some((f, node.id())),
        _ => None,
    });
    let first = found.next()?;
    if found.next().is_some() { return None; }
    Some(first)
}
fn parameter(f: &Function<'_>, index: usize) -> Option<SymbolId> {
    match &f.params.items.get(index)?.pattern.kind {
        BindingPatternKind::BindingIdentifier(id) => id.symbol_id.get(),
        BindingPatternKind::AssignmentPattern(p) => match &p.left.kind {
            BindingPatternKind::BindingIdentifier(id) => id.symbol_id.get(), _ => None,
        },
        _ => None,
    }
}
fn owner(s: &Semantic<'_>, node: NodeId) -> Option<NodeId> {
    // Oxc 0.75's ancestors iterator includes the supplied node itself.
    s.nodes().ancestors(node).skip(1).find(|n| matches!(n.kind(), AstKind::Function(_) | AstKind::ArrowFunctionExpression(_))).map(|n| n.id())
}
fn expression_parent(s: &Semantic<'_>, node: NodeId) -> Option<NodeId> {
    let parent = s.nodes().parent_node(node)?;
    if matches!(parent.kind(), AstKind::Argument(_)) { s.nodes().parent_id(parent.id()) } else { Some(parent.id()) }
}
fn has_ancestor(s: &Semantic<'_>, node: NodeId, ancestor: NodeId) -> bool {
    s.nodes().ancestors(node).any(|n| n.id() == ancestor)
}
fn stable_symbol(s: &Semantic<'_>, id: SymbolId) -> bool {
    !s.scoping().get_resolved_references(id).any(|reference| reference.is_write())
}
fn returned_member(s: &Semantic<'_>, fnode: NodeId, name: &str, expected: SymbolId) -> bool {
    s.nodes().iter().any(|n| {
        let AstKind::ReturnStatement(r) = n.kind() else { return false; };
        if owner(s, n.id()) != Some(fnode) { return false; }
        let Some(Expression::ObjectExpression(o)) = r.argument.as_ref().map(Expression::get_inner_expression) else { return false; };
        let Some(props) = fields(o) else { return false; };
        let Some((_, value)) = props.iter().find(|(key, _)| *key == name) else { return false; };
        if binding(value, s) == Some(expected) { return true; }
        // The maintained context owner may wrap the native run, but both the
        // supplied callback and the nullish fallback must be that exact run.
        let Expression::LogicalExpression(coalesce) = value.get_inner_expression() else { return false; };
        if coalesce.operator != LogicalOperator::Coalesce || binding(&coalesce.right, s) != Some(expected) { return false; }
        let Expression::ChainExpression(chain) = coalesce.left.get_inner_expression() else { return false; };
        let ChainElement::CallExpression(call) = &chain.expression else { return false; };
        let Expression::StaticMemberExpression(method) = call.callee.get_inner_expression() else { return false; };
        method.property.name == "wrapRun" && method.optional
            && hook(&method.object, "grokbox.box-runtime.context-control.v1", s)
            && call.arguments.len() == 4
            && call.arguments[1].as_expression().and_then(|e| binding(e, s)) == Some(expected)
    })
}

fn fenced_run(s: &Semantic<'_>, run: &Function<'_>, native: SymbolId, host: SymbolId) -> bool {
    let Some(body) = &run.body else { return false; };
    if body.statements.len() != 3 { return false; }
    let Statement::VariableDeclaration(owner) = &body.statements[0] else { return false; };
    let Statement::VariableDeclaration(callback) = &body.statements[1] else { return false; };
    if owner.kind != VariableDeclarationKind::Const || callback.kind != VariableDeclarationKind::Const || owner.declarations.len() != 1 || callback.declarations.len() != 1 { return false; }
    let Some(init) = owner.declarations[0].init.as_ref() else { return false; };
    if !hook(init,"grokbox.box-runtime.native-current-state.v1",s) { return false; }
    let BindingPatternKind::BindingIdentifier(owner_id) = &owner.declarations[0].id.kind else { return false; };
    let BindingPatternKind::BindingIdentifier(callback_id) = &callback.declarations[0].id.kind else { return false; };
    let Some(Expression::LogicalExpression(fallback)) = callback.declarations[0].init.as_ref().map(Expression::get_inner_expression) else { return false; };
    if fallback.operator != LogicalOperator::Coalesce || binding(&fallback.right,s) != Some(native) { return false; }
    let Expression::ChainExpression(chain) = fallback.left.get_inner_expression() else { return false; };
    let ChainElement::CallExpression(wrap) = &chain.expression else { return false; };
    let Expression::StaticMemberExpression(method) = wrap.callee.get_inner_expression() else { return false; };
    if !method.optional || method.property.name != "wrapRun" || binding(&method.object,s) != owner_id.symbol_id.get() || wrap.arguments.len() != 2
        || wrap.arguments[0].as_expression().and_then(|e|binding(e,s)) != Some(host)
        || wrap.arguments[1].as_expression().and_then(|e|binding(e,s)) != Some(native) { return false; }
    let Statement::ReturnStatement(ret) = &body.statements[2] else { return false; };
    let Some(Expression::AwaitExpression(awaited)) = ret.argument.as_ref().map(Expression::get_inner_expression) else { return false; };
    let Some(call) = call(&awaited.argument) else { return false; };
    call.arguments.len() == 2 && binding(&call.callee,s) == callback_id.symbol_id.get()
        && call.arguments.iter().enumerate().all(|(i,a)|a.as_expression().and_then(|e|binding(e,s)) == parameter(run,i))
        && stable_symbol(s,native)
}

pub(super) struct TurnShell {
    pub host: SymbolId,
    pub options: SymbolId,
    pub run_turn_node: NodeId,
}
pub(super) fn has_function(s: &Semantic<'_>, name: &str) -> bool {
    s.nodes().iter().any(|n| matches!(n.kind(), AstKind::Function(f) if f.id.as_ref().is_some_and(|id| id.name == name)))
}
pub(super) fn has_shell(s: &Semantic<'_>) -> bool { has_function(s,"createTurnRunShell") }
pub(super) fn turn_shell(s: &Semantic<'_>) -> Result<TurnShell, &'static str> {
    let (shell, shell_node) = function(s, "createTurnRunShell").ok_or("turn-shell-not-unique")?;
    if owner(s, shell_node).is_some() || shell.params.items.len() != 1 { return Err("turn-shell-owner-unproven"); }
    let shell_symbol = shell.id.as_ref().and_then(|id|id.symbol_id.get()).ok_or("turn-shell-binding-unproven")?;
    let host = parameter(shell, 0).ok_or("turn-shell-host-unproven")?;
    if !stable_symbol(s, shell_symbol) || !stable_symbol(s, host) { return Err("turn-shell-binding-written"); }
    let children: Vec<_> = s.nodes().iter().filter_map(|n| match n.kind() {
        AstKind::Function(f) if owner(s, n.id()) == Some(shell_node) => Some((f, n.id())), _ => None,
    }).collect();
    let select = |name: &str| {
        let matches: Vec<_> = children.iter().filter(|(f, _)| f.id.as_ref().is_some_and(|id| id.name == name)).copied().collect();
        (matches.len() == 1).then(|| matches[0])
    };
    let (run, run_node) = select("run").ok_or("turn-shell-run-not-unique")?;
    let (run_turn, run_turn_node) = select("runTurn").ok_or("turn-shell-turn-not-unique")?;
    let run_symbol = run.id.as_ref().and_then(|id|id.symbol_id.get()).ok_or("turn-run-binding-unproven")?;
    let turn_symbol = run_turn.id.as_ref().and_then(|id|id.symbol_id.get()).ok_or("turn-entry-binding-unproven")?;
    if !run.r#async || !run_turn.r#async || !stable_symbol(s, run_symbol) || !stable_symbol(s, turn_symbol) { return Err("turn-shell-run-written"); }
    if !returned_member(s, shell_node, "run", run_symbol) { return Err("turn-shell-run-not-returned"); }
    let refs: Vec<_> = s.scoping().get_resolved_references(turn_symbol).collect();
    if refs.len() != 1 { return Err("turn-entry-call-not-unique"); }
    let reference = refs[0];
    if owner(s, reference.node_id()) != Some(run_node) {
        let Some(native_node) = owner(s, reference.node_id()) else { return Err("turn-entry-owner-unproven"); };
        let AstKind::Function(native) = s.nodes().kind(native_node) else { return Err("turn-entry-owner-unproven"); };
        if owner(s,native_node) != Some(shell_node) || !native.id.as_ref().and_then(|id|id.symbol_id.get()).is_some_and(|id|fenced_run(s,run,id,host)) {
            return Err("turn-entry-fence-unproven");
        }
    }
    let parent = s.nodes().parent_node(reference.node_id()).ok_or("turn-entry-call-unproven")?;
    let AstKind::CallExpression(c) = parent.kind() else { return Err("turn-entry-not-called"); };
    if binding(&c.callee, s) != Some(turn_symbol) || !matches!(s.nodes().parent_kind(parent.id()), Some(AstKind::AwaitExpression(_))) { return Err("turn-entry-not-awaited"); }
    Ok(TurnShell { host, options: parameter(run_turn, 1).ok_or("turn-options-unproven")?, run_turn_node })
}

// Enumerate the finite write-set of an object literal spread. Branches are
// mutually exclusive; unknown objects, computed keys, getters and __proto__ are
// not a proof that later spreads leave the injected identities untouched.
fn spread_keys(e: &Expression<'_>, depth: usize) -> Option<HashSet<String>> {
    if depth > 8 { return None; }
    match e.get_inner_expression() {
        Expression::ConditionalExpression(c) => {
            let mut keys = spread_keys(&c.consequent, depth + 1)?;
            keys.extend(spread_keys(&c.alternate, depth + 1)?);
            Some(keys)
        }
        Expression::ObjectExpression(o) => {
            let mut keys = HashSet::new();
            for p in &o.properties {
                let incoming = match p {
                    ObjectPropertyKind::SpreadProperty(p) => spread_keys(&p.argument, depth + 1)?,
                    ObjectPropertyKind::ObjectProperty(p) => {
                        let PropertyKey::StaticIdentifier(key) = &p.key else { return None; };
                        if p.computed || p.method || p.kind != PropertyKind::Init || key.name == "__proto__" { return None; }
                        HashSet::from([key.name.to_string()])
                    }
                };
                if incoming.iter().any(|key| keys.contains(key)) { return None; }
                keys.extend(incoming);
            }
            Some(keys)
        }
        _ => None,
    }
}
pub(super) fn disjoint_fields<'a,'b>(o: &'b ObjectExpression<'a>) -> Option<Vec<(&'b str, &'b Expression<'a>)>> {
    let mut keys = HashSet::new();
    let mut direct = Vec::new();
    for p in &o.properties {
        let incoming = match p {
            ObjectPropertyKind::SpreadProperty(p) => spread_keys(&p.argument, 0)?,
            ObjectPropertyKind::ObjectProperty(p) => {
                let PropertyKey::StaticIdentifier(key) = &p.key else { return None; };
                if p.computed || p.method || p.kind != PropertyKind::Init || key.name == "__proto__" { return None; }
                direct.push((key.name.as_str(), &p.value));
                HashSet::from([key.name.to_string()])
            }
        };
        if incoming.iter().any(|key| keys.contains(key)) { return None; }
        keys.extend(incoming);
    }
    Some(direct)
}
fn trace_callback_consumed(s: &Semantic<'_>, node: NodeId) -> bool {
    let Some(arrow_node) = s.nodes().ancestors(node).find(|n| matches!(n.kind(), AstKind::ArrowFunctionExpression(_))) else { return false; };
    let AstKind::ArrowFunctionExpression(arrow) = arrow_node.kind() else { return false; };
    if !arrow.r#async || !arrow.expression || !arrow.params.items.is_empty() || arrow.params.rest.is_some() { return false; }
    let Some(parent) = expression_parent(s, arrow_node.id()) else { return false; };
    let AstKind::CallExpression(trace) = s.nodes().kind(parent) else { return false; };
    let Some((definition, definition_node)) = function(s, "traceSendPhase") else { return false; };
    let Some(symbol) = definition.id.as_ref().and_then(|id| id.symbol_id.get()) else { return false; };
    if !stable_symbol(s, symbol) || binding(&trace.callee, s) != Some(symbol) || trace.optional || trace.arguments.len() != 3
        || trace.arguments[2].span() != arrow.span { return false; }
    let Some(callback) = parameter(definition, 2) else { return false; };
    let references: Vec<_> = s.scoping().get_resolved_references(callback).collect();
    // The trace adapter only invokes the supplied callback and returns its
    // awaited value. Its exception/timing instrumentation is not inference.
    if references.is_empty() || references.len() > 8 { return false; }
    let returns: Vec<_> = s.nodes().iter().filter_map(|n| match n.kind() {
        AstKind::ReturnStatement(r) if owner(s,n.id()) == Some(definition_node) => Some(r), _ => None,
    }).collect();
    if returns.len() != references.len() || returns.iter().any(|r| {
        let Some(Expression::AwaitExpression(a)) = r.argument.as_ref().map(Expression::get_inner_expression) else { return true; };
        !call(&a.argument).is_some_and(|c| binding(&c.callee,s) == Some(callback))
    }) { return false; }
    references.iter().all(|r| {
        let Some(call_node) = s.nodes().parent_node(r.node_id()) else { return false; };
        let AstKind::CallExpression(c) = call_node.kind() else { return false; };
        let Some(await_node) = s.nodes().parent_node(call_node.id()) else { return false; };
        !r.is_write() && binding(&c.callee, s) == Some(callback) && !c.optional
            && matches!(await_node.kind(), AstKind::AwaitExpression(_))
            && matches!(s.nodes().parent_kind(await_node.id()), Some(AstKind::ReturnStatement(_)))
            && !s.nodes().ancestors(r.node_id()).take_while(|n| n.kind().span() != definition.span)
                .any(|n| matches!(n.kind(), AstKind::ForStatement(_) | AstKind::WhileStatement(_) | AstKind::DoWhileStatement(_)))
    })
}
pub(super) fn main_path(s: &Semantic<'_>, node: NodeId, shell: &TurnShell) -> bool {
    has_ancestor(s, node, shell.run_turn_node) && control_path(s, node, None) && trace_callback_consumed(s, node)
}
pub(super) fn main_identity<'a>(s: &Semantic<'a>, fields: &[(&str, &Expression<'a>)], shell: &TurnShell) -> bool {
    let get = |key| fields.iter().find(|(k, _)| *k == key).map(|(_, v)| *v);
    if !stable_symbol(s,shell.options) { return false; }
    let Some(agent) = get("agentId").and_then(call) else { return false; };
    let Some(turn) = get("invocationId") else { return false; };
    if !agent.arguments.is_empty() || !member(&agent.callee, "getConversationId").is_some_and(|e|method_unmodified(e,"inference",s))
        || member(&agent.callee, "getConversationId").and_then(|e| binding(e, s)) != Some(shell.host)
        || !get("clientNonce").and_then(|e| member(e, "clientNonce")).is_some_and(|e| binding(e, s) == Some(shell.options))
        || !unmodified(turn, s) || frame(turn, s) != Some(shell.run_turn_node) { return false; }
    let Some(Expression::LogicalExpression(value)) = initializer(turn, s).map(Expression::get_inner_expression) else { return false; };
    let Some(uuid) = call(&value.right) else { return false; };
    value.operator == LogicalOperator::Coalesce
        && member(&value.left, "inferenceRequestId").and_then(|e| binding(e, s)) == Some(shell.options)
        && member(&uuid.callee, "randomUUID").is_some_and(|e| global(e, "crypto", s)) && uuid.arguments.is_empty()
}

fn returned_retry_closure(s: &Semantic<'_>, call_node: NodeId, factory: NodeId, executor: SymbolId) -> bool {
    let Some(bounded) = s.nodes().ancestors(call_node).find(|n| matches!(n.kind(), AstKind::ArrowFunctionExpression(_))) else { return false; };
    let AstKind::ArrowFunctionExpression(arrow) = bounded.kind() else { return false; };
    if !arrow.r#async || !arrow.expression || arrow.body.statements.len() != 1 { return false; }
    let Statement::ExpressionStatement(statement) = &arrow.body.statements[0] else { return false; };
    let Expression::ConditionalExpression(branch) = statement.expression.get_inner_expression() else { return false; };
    let Expression::BinaryExpression(test) = branch.test.get_inner_expression() else { return false; };
    if test.operator != BinaryOperator::GreaterThan || member(&test.left,"maxAttempts").is_none()
        || !matches!(test.right.get_inner_expression(), Expression::NumericLiteral(n) if n.value == 1.0) { return false; }
    let Expression::AwaitExpression(yes) = branch.consequent.get_inner_expression() else { return false; };
    let Some(invoke) = call(&yes.argument) else { return false; };
    let Expression::AwaitExpression(no) = branch.alternate.get_inner_expression() else { return false; };
    let Some(once) = call(&no.argument) else { return false; };
    if binding(&invoke.callee,s) != Some(executor) || invoke.span != s.nodes().kind(call_node).span()
        || !invoke.arguments[0].as_expression().is_some_and(|e| same(e,&once.callee,s)) || !once.arguments.is_empty() { return false; }
    let Some(AstKind::VariableDeclarator(decl)) = s.nodes().parent_kind(bounded.id()) else { return false; };
    let BindingPatternKind::BindingIdentifier(id) = &decl.id.kind else { return false; };
    let Some(symbol) = id.symbol_id.get() else { return false; };
    let refs: Vec<_> = s.scoping().get_resolved_references(symbol).collect();
    if refs.len() != 1 || refs[0].is_write() || !control_path(s,refs[0].node_id(),None) { return false; }
    let Some(c) = s.nodes().parent_node(refs[0].node_id()) else { return false; };
    if !matches!(c.kind(), AstKind::CallExpression(c) if binding(&c.callee,s) == Some(symbol))
        || !matches!(s.nodes().parent_kind(c.id()),Some(AstKind::AwaitExpression(_))) { return false; }
    let Some(run) = s.nodes().ancestors(c.id()).find(|n| matches!(n.kind(),AstKind::ArrowFunctionExpression(_))) else { return false; };
    let Some(AstKind::VariableDeclarator(decl)) = s.nodes().parent_kind(run.id()) else { return false; };
    let BindingPatternKind::BindingIdentifier(id) = &decl.id.kind else { return false; };
    id.symbol_id.get().is_some_and(|id| stable_symbol(s,id) && returned_member(s,factory,"run",id))
}

pub(super) fn retry_consumer(s: &Semantic<'_>, policy_symbol: SymbolId) -> bool {
    let Some((attempt, attempt_node)) = function(s, "createStreamAttempt") else { return false; };
    let Some((executor, _)) = function(s, "runWithTransientRetry") else { return false; };
    let Some(executor_symbol) = executor.id.as_ref().and_then(|id| id.symbol_id.get()) else { return false; };
    if attempt.params.items.len() != 1 || !stable_symbol(s, policy_symbol) || !stable_symbol(s, executor_symbol) { return false; }
    let references: Vec<_> = s.scoping().get_resolved_references(policy_symbol).collect();
    if references.len() != 1 { return false; }
    let r = references[0];
    if !has_ancestor(s, r.node_id(), attempt_node) { return false; }
    let Some(call_node) = s.nodes().parent_node(r.node_id()) else { return false; };
    let AstKind::CallExpression(invoke) = call_node.kind() else { return false; };
    let Some(arrow_node) = s.nodes().parent_node(call_node.id()).and_then(|n| {
        // Oxc expression-bodied arrows have a synthetic expression statement
        // and FunctionBody; inspect lexical ancestors, not node-name strings.
        s.nodes().ancestors(n.id()).find(|p| matches!(p.kind(), AstKind::ArrowFunctionExpression(_)))
    }) else { return false; };
    let AstKind::ArrowFunctionExpression(arrow) = arrow_node.kind() else { return false; };
    if arrow.r#async || !arrow.expression || arrow.params.items.len() != 1 || invoke.arguments.len() != 1 { return false; }
    let BindingPatternKind::BindingIdentifier(error) = &arrow.params.items[0].pattern.kind else { return false; };
    let Some(Expression::ObjectExpression(input)) = invoke.arguments[0].as_expression() else { return false; };
    let Some(input_fields) = fields(input) else { return false; };
    if !input_fields.iter().any(|(key, value)| *key == "error" && binding(value, s) == error.symbol_id.get()) { return false; }
    let Some(prop_node) = s.nodes().parent_node(arrow_node.id()) else { return false; };
    let AstKind::ObjectProperty(prop) = prop_node.kind() else { return false; };
    if prop.computed || !matches!(&prop.key, PropertyKey::StaticIdentifier(key) if key.name == "isRetryable") { return false; }
    let Some(object_node) = s.nodes().parent_node(prop_node.id()) else { return false; };
    let AstKind::ObjectExpression(options) = object_node.kind() else { return false; };
    // Arbitrary leading policy fields are overwritten by the final exact
    // predicate. A later spread/property could override it and is refused.
    let Some(position) = options.properties.iter().position(|p| p.span() == prop.span) else { return false; };
    if options.properties[position+1..].iter().any(|p| match p {
        ObjectPropertyKind::SpreadProperty(_) => true,
        ObjectPropertyKind::ObjectProperty(p) => p.computed || matches!(&p.key, PropertyKey::StaticIdentifier(k) if k.name == "isRetryable"),
    }) { return false; }
    let Some(execution) = expression_parent(s, object_node.id()) else { return false; };
    let AstKind::CallExpression(c) = s.nodes().kind(execution) else { return false; };
    if binding(&c.callee, s) != Some(executor_symbol) || c.arguments.len() != 2 || c.arguments[1].span() != options.span
        || !returned_retry_closure(s, execution, attempt_node, executor_symbol) { return false; }
    // Independently establish that the executor consumes its supplied policy
    // predicate and tests the SAME caught exception before retrying.
    let Some(parameter) = parameter(executor, 1) else { return false; };
    s.nodes().iter().any(|n| {
        let AstKind::VariableDeclarator(d) = n.kind() else { return false; };
        if !executor.span.contains_inclusive(d.span) { return false; }
        let BindingPatternKind::BindingIdentifier(predicate) = &d.id.kind else { return false; };
        let Some(Expression::LogicalExpression(init)) = d.init.as_ref().map(Expression::get_inner_expression) else { return false; };
        if init.operator != LogicalOperator::Coalesce || member(&init.left, "isRetryable").and_then(|e| binding(e,s)) != Some(parameter) { return false; }
        let Some(predicate_id) = predicate.symbol_id.get() else { return false; };
        let uses: Vec<_> = s.scoping().get_resolved_references(predicate_id).collect();
        if uses.len() != 1 || uses[0].is_write() { return false; }
        let Some(use_node) = s.nodes().parent_node(uses[0].node_id()) else { return false; };
        let AstKind::CallExpression(test) = use_node.kind() else { return false; };
        let caught = s.nodes().ancestors(use_node.id()).find_map(|n| match n.kind() {
            AstKind::CatchClause(c) => c.param.as_ref().and_then(|p| match &p.pattern.kind { BindingPatternKind::BindingIdentifier(id) => id.symbol_id.get(), _ => None }), _ => None,
        });
        if caught.is_none() || test.arguments.len() != 1 || test.arguments[0].as_expression().and_then(|e| binding(e,s)) != caught { return false; }
        let Some(not) = s.nodes().parent_node(use_node.id()) else { return false; };
        if !matches!(not.kind(), AstKind::UnaryExpression(u) if u.operator == UnaryOperator::LogicalNot) { return false; }
        let Some(or) = s.nodes().parent_node(not.id()) else { return false; };
        if !matches!(or.kind(), AstKind::LogicalExpression(e) if e.operator == LogicalOperator::Or && e.right.span() == not.kind().span()) { return false; }
        let Some(guard) = s.nodes().parent_node(or.id()) else { return false; };
        let AstKind::IfStatement(guard) = guard.kind() else { return false; };
        let catch = s.nodes().ancestors(use_node.id()).find_map(|n| if let AstKind::CatchClause(c) = n.kind() { Some(c) } else { None });
        guard.alternate.is_none() && catch.is_some_and(|c|c.body.body.first().is_some_and(|statement|statement.span() == guard.span))
            && matches!(one_statement(&guard.consequent),Some(Statement::ThrowStatement(t)) if binding(&t.argument,s) == caught)
    })
}

/// Syntactic def/use of a particular method, not immutability of all metadata
/// on its native receiver. Native state owners legitimately update other fields.
pub(super) fn method_unmodified(e: &Expression<'_>, name: &str, s: &Semantic<'_>) -> bool {
    let Some(symbol) = binding(e,s) else { return false; };
    if !stable_symbol(s,symbol) { return false; }
    for reference in s.scoping().get_resolved_references(symbol) {
        let at = s.nodes().kind(reference.node_id()).span().start;
        for n in s.nodes().ancestors(reference.node_id()) {
            match n.kind() {
                AstKind::AssignmentExpression(a) if a.left.span().start <= at && at < a.left.span().end => {
                    if !matches!(&a.left,AssignmentTarget::StaticMemberExpression(m) if binding(&m.object,s) == Some(symbol) && m.property.name != name) { return false; }
                }
                AstKind::UpdateExpression(a) if a.argument.span().start <= at && at < a.argument.span().end => {
                    if !matches!(&a.argument,SimpleAssignmentTarget::StaticMemberExpression(m) if binding(&m.object,s) == Some(symbol) && m.property.name != name) { return false; }
                }
                AstKind::UnaryExpression(a) if a.operator == UnaryOperator::Delete => {
                    if !matches!(a.argument.get_inner_expression(),Expression::StaticMemberExpression(m) if binding(&m.object,s) == Some(symbol) && m.property.name != name) { return false; }
                }
                AstKind::CallExpression(c) if member(&c.callee,"assign").is_some_and(|e| global(e,"Object",s))
                    && c.arguments.first().and_then(|a| a.as_expression()).and_then(|e|binding(e,s)) == Some(symbol) => return false,
                _ => {}
            }
        }
    }
    true
}

fn class_callback_consumed(s: &Semantic<'_>, node: NodeId, class: NodeId) -> bool {
    for ancestor in s.nodes().ancestors(node) {
        match ancestor.kind() {
            AstKind::ArrowFunctionExpression(arrow) => {
                let Some(call_node) = expression_parent(s,ancestor.id()) else { return false; };
                let AstKind::CallExpression(c) = s.nodes().kind(call_node) else { return false; };
                let Expression::StaticMemberExpression(member) = c.callee.get_inner_expression() else { return false; };
                if member.optional || c.optional || !matches!(member.object.get_inner_expression(),Expression::ThisExpression(_)) { return false; }
                let Some(index) = c.arguments.iter().position(|arg|arg.span() == arrow.span) else { return false; };
                let consumers: Vec<_> = s.nodes().iter().filter_map(|n| match n.kind() {
                    AstKind::MethodDefinition(m) if !m.computed && matches!(&m.key,PropertyKey::StaticIdentifier(k) if k.name == member.property.name)
                        && s.nodes().ancestors(n.id()).find(|n|matches!(n.kind(),AstKind::Class(_))).map(|n|n.id()) == Some(class) => Some(m),
                    _ => None,
                }).collect();
                if consumers.len() != 1 { return false; }
                let Some(callback) = parameter(&consumers[0].value,index) else { return false; };
                let refs: Vec<_> = s.scoping().get_resolved_references(callback).collect();
                if refs.is_empty() || refs.iter().any(|r| r.is_write() || !matches!(s.nodes().parent_kind(r.node_id()),Some(AstKind::CallExpression(c)) if !c.optional && binding(&c.callee,s) == Some(callback))) { return false; }
            }
            AstKind::Function(_) => return matches!(s.nodes().parent_kind(ancestor.id()),Some(AstKind::MethodDefinition(_))),
            _ => {}
        }
    }
    false
}

pub(super) fn checkpoint_owner(s: &Semantic<'_>, node: NodeId) -> bool {
    let Some(method_node) = s.nodes().ancestors(node).find(|n| matches!(n.kind(), AstKind::MethodDefinition(_))) else { return false; };
    let AstKind::MethodDefinition(method) = method_node.kind() else { return false; };
    if method.computed || method.r#static || !matches!(&method.key, PropertyKey::StaticIdentifier(key) if key.name == "runStep") { return false; }
    let Some(class_node) = s.nodes().ancestors(method_node.id()).find(|n| matches!(n.kind(), AstKind::Class(_))) else { return false; };
    let AstKind::Class(class) = class_node.kind() else { return false; };
    let named = class.id.as_ref().is_some_and(|id| id.name == "AbstractUserMessageActionHandler") || matches!(s.nodes().parent_kind(class_node.id()), Some(AstKind::VariableDeclarator(v)) if matches!(&v.id.kind, BindingPatternKind::BindingIdentifier(id) if id.name == "AbstractUserMessageActionHandler"));
    if !named { return false; }
    let methods: Vec<_> = s.nodes().iter().filter_map(|n| match n.kind() {
        AstKind::MethodDefinition(m) if s.nodes().ancestors(n.id()).find(|n| matches!(n.kind(), AstKind::Class(_))).map(|n| n.id()) == Some(class_node.id()) => Some(m), _ => None,
    }).collect();
    if methods.iter().filter(|m| matches!(&m.key, PropertyKey::StaticIdentifier(key) if key.name == "runStep")).count() != 1 { return false; }
    if s.nodes().iter().any(|n| match n.kind() {
        AstKind::AssignmentExpression(a) => class.span.contains_inclusive(a.span)
            && matches!(&a.left, AssignmentTarget::StaticMemberExpression(m) if m.property.name == "runStep"),
        _ => false,
    }) { return false; }
    s.nodes().iter().any(|n| {
        let AstKind::CallExpression(c) = n.kind() else { return false; };
        let caller = s.nodes().ancestors(n.id()).find(|n| matches!(n.kind(), AstKind::Function(_)));
        let method_caller = caller.is_some_and(|f| matches!(s.nodes().parent_kind(f.id()), Some(AstKind::MethodDefinition(_))));
        method_caller && control_path(s,n.id(),None) && class_callback_consumed(s,n.id(),class_node.id())
            && !method.span.contains_inclusive(c.span) && class.span.contains_inclusive(c.span)
            && member(&c.callee,"runStep").is_some_and(|e| matches!(e.get_inner_expression(), Expression::ThisExpression(_)))
            && s.nodes().ancestors(n.id()).find(|n| matches!(n.kind(), AstKind::Class(_))).map(|n| n.id()) == Some(class_node.id())
    })
}
