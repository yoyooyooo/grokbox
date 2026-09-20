//! Pure static analysis. No file descriptors, paths, environment, transport,
//! process control, storage or final product-health decisions belong here.
use oxc_allocator::Allocator;
use oxc_ast::{ast::*, AstKind};
use oxc_parser::Parser;
use oxc_semantic::{Semantic, SemanticBuilder};
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::node::NodeId;
use oxc_syntax::{operator::{BinaryOperator, LogicalOperator, UnaryOperator}, symbol::SymbolId};

mod native_roles;
mod lease_lifetime;

pub const CHECKS: &[(&str, u64)] = &[("session.main-binding",2),("retry.turn-guard",2),("context.checkpoint-await",2),("context.lease-finally",1)];
pub struct Finding { pub id: String, pub revision: u64, pub state: &'static str, pub code: &'static str, pub start: u32, pub end: u32 }
pub struct Analysis { pub valid: bool, pub diagnostics: usize, pub nodes: usize, pub findings: Vec<Finding> }
fn finding(id: &str, revision: u64, state: &'static str, code: &'static str, span: Span) -> Finding {
    Finding { id: id.into(), revision, state, code, start:span.start, end:span.end }
}
fn binding(e: &Expression<'_>, s: &Semantic<'_>) -> Option<SymbolId> {
    if let Expression::Identifier(i)=e.get_inner_expression() { i.reference_id.get().and_then(|r|s.scoping().get_reference(r).symbol_id()) } else { None }
}
fn same(a: &Expression<'_>, b: &Expression<'_>, s: &Semantic<'_>) -> bool { binding(a,s).is_some() && binding(a,s)==binding(b,s) }
fn unmodified(e: &Expression<'_>, s: &Semantic<'_>) -> bool {
    binding(e,s).is_some_and(|id| {
        let declared = match s.symbol_declaration(id).kind() {
            AstKind::VariableDeclarator(v) => v.init.is_some() && v.span.end <= e.span().start,
            _ => true,
        };
        declared && !s.scoping().get_resolved_references(id).any(|r| {
            if r.is_write() { return true; }
            let start=s.nodes().get_node(r.node_id()).kind().span().start;
            s.nodes().ancestors(r.node_id()).any(|parent| match parent.kind() {
                AstKind::AssignmentExpression(a) => a.left.span().start<=start && start<a.left.span().end,
                AstKind::UpdateExpression(a) => a.argument.span().start<=start && start<a.argument.span().end,
                AstKind::UnaryExpression(a) => a.operator==UnaryOperator::Delete && a.argument.span().start<=start && start<a.argument.span().end,
                _ => false,
            })
        })
    })
}
fn frame(e: &Expression<'_>, s: &Semantic<'_>) -> Option<NodeId> {
    let declaration=s.symbol_declaration(binding(e,s)?);
    s.nodes().ancestors(declaration.id()).find(|n| matches!(n.kind(),AstKind::Function(_)|AstKind::ArrowFunctionExpression(_)|AstKind::Program(_))).map(|n|n.id())
}
fn global(e: &Expression<'_>, name: &str, s: &Semantic<'_>) -> bool {
    matches!(e.get_inner_expression(),Expression::Identifier(i) if i.name==name && binding(e,s).is_none())
}
fn member<'a,'b>(e: &'b Expression<'a>, name: &str) -> Option<&'b Expression<'a>> {
    match e.get_inner_expression() { Expression::StaticMemberExpression(m) if !m.optional && m.property.name==name => Some(&m.object), _=>None }
}
fn call<'a,'b>(e: &'b Expression<'a>) -> Option<&'b CallExpression<'a>> {
    if let Expression::CallExpression(c)=e.get_inner_expression() { if !c.optional {return Some(c);} } None
}
fn initializer<'a>(e: &Expression<'a>, s: &Semantic<'a>) -> Option<&'a Expression<'a>> {
    let id=binding(e,s)?;
    match s.symbol_declaration(id).kind() {AstKind::VariableDeclarator(v)=>v.init.as_ref(),_=>None}
}
fn hook(e: &Expression<'_>, symbol: &str, s: &Semantic<'_>) -> bool {
    let Expression::ComputedMemberExpression(m)=e.get_inner_expression() else{return false;};
    if m.optional || !global(&m.object,"globalThis",s) {return false;}
    let Some(c)=call(&m.expression) else{return false;};
    if c.arguments.len()!=1 || !member(&c.callee,"for").is_some_and(|v|global(v,"Symbol",s)) {return false;}
    matches!(c.arguments[0].as_expression(),Some(Expression::StringLiteral(v)) if v.value==symbol)
}
fn fields<'a,'b>(o: &'b ObjectExpression<'a>) -> Option<Vec<(&'b str,&'b Expression<'a>)>> {
    let mut out=Vec::new();
    for p in &o.properties {
        let ObjectPropertyKind::ObjectProperty(p)=p else{return None;};
        if p.computed || p.method || p.kind!=PropertyKind::Init {return None;}
        let PropertyKey::StaticIdentifier(key)=&p.key else{return None;};
        if out.iter().any(|(k,_)|*k==key.name.as_str()) {return None;}
        out.push((key.name.as_str(),&p.value));
    } Some(out)
}
// A local predicate cannot certify a call in a dead or unsupported branch.
// Use Oxc's real CFG for terminated blocks, and explicitly admit only the
// supported positive hook-presence guard. This is a finite local proof, not
// whole-program reachability or evidence that the native host invoked it.
fn control_path(s: &Semantic<'_>, node: NodeId, guarded_hook: Option<&Expression<'_>>) -> bool {
    let Some(cfg) = s.cfg() else { return false; };
    let here = s.nodes().get_node(node);
    if cfg.basic_block(here.cfg_id()).is_unreachable() { return false; }
    let start = here.kind().span().start;
    for parent in s.nodes().ancestors(node) {
        if cfg.basic_block(parent.cfg_id()).is_unreachable() { return false; }
        match parent.kind() {
            AstKind::IfStatement(i) => {
                let Some(expected) = guarded_hook else { return false; };
                if start < i.consequent.span().start || start >= i.consequent.span().end { return false; }
                let Expression::BinaryExpression(eq) = i.test.get_inner_expression() else { return false; };
                let Expression::UnaryExpression(ty) = eq.left.get_inner_expression() else { return false; };
                if eq.operator != BinaryOperator::StrictEquality || ty.operator != UnaryOperator::Typeof
                    || !same(&ty.argument, expected, s)
                    || !matches!(eq.right.get_inner_expression(), Expression::StringLiteral(v) if v.value == "function") { return false; }
            }
            AstKind::ConditionalExpression(_) | AstKind::LogicalExpression(_)
                | AstKind::ForStatement(_) | AstKind::ForInStatement(_) | AstKind::ForOfStatement(_)
                | AstKind::WhileStatement(_) | AstKind::DoWhileStatement(_) | AstKind::SwitchStatement(_) => return false,
            _ => {}
        }
    }
    true
}
fn exported_module_target(target: &AssignmentTarget<'_>, s:&Semantic<'_>) -> bool {
    matches!(target,AssignmentTarget::StaticMemberExpression(m) if !m.optional && m.property.name=="exports" && global(&m.object,"module",s))
}
// Bounded reachability for supported direct calls / CJS registrations. Merely
// declaring a correctly-shaped but unused function cannot establish its role.
// Dynamic registries, escaped closures and unresolved aliases remain unsupported.
fn exposed_symbol(s:&Semantic<'_>, symbol:SymbolId, seen:&mut Vec<SymbolId>) -> bool {
    if seen.len()>=8 || seen.contains(&symbol) { return false; }
    seen.push(symbol);
    let result=s.scoping().get_resolved_references(symbol).any(|reference| {
        if reference.is_write() || !control_path(s,reference.node_id(),None) { return false; }
        let ancestors:Vec<_>=s.nodes().ancestors(reference.node_id()).collect();
        let owner=ancestors.iter().find(|n|matches!(n.kind(),AstKind::Function(_)|AstKind::ArrowFunctionExpression(_)));
        if let Some(AstKind::CallExpression(c))=s.nodes().parent_kind(reference.node_id()) {
            if binding(&c.callee,s)==Some(symbol) {
                return owner.map_or(true,|node| match node.kind() {
                    AstKind::Function(f)=>f.id.as_ref().and_then(|i|i.symbol_id.get()).is_some_and(|id|exposed_symbol(s,id,seen)),
                    _=>false,
                });
            }
        }
        if owner.is_some() { return false; }
        let Some(assignment)=ancestors.iter().find_map(|n|if let AstKind::AssignmentExpression(a)=n.kind(){Some(a)}else{None}) else {return false;};
        if !exported_module_target(&assignment.left,s) {return false;}
        if s.nodes().iter().filter(|n|matches!(n.kind(),AstKind::AssignmentExpression(a) if exported_module_target(&a.left,s))).count()!=1 {return false;}
        match assignment.right.get_inner_expression() {
            Expression::Identifier(i)=>i.reference_id.get().and_then(|r|s.scoping().get_reference(r).symbol_id())==Some(symbol),
            Expression::ObjectExpression(o)=>fields(o).is_some_and(|f|f.iter().any(|(_,value)|binding(value,s)==Some(symbol))),
            _=>false,
        }
    });
    seen.pop();result
}
fn exposed_owner(s:&Semantic<'_>, node:NodeId) -> bool {
    for parent in s.nodes().ancestors(node) {
        match parent.kind() {
            AstKind::ArrowFunctionExpression(_) => {
                // A directly returned closure is reachable through its owner;
                // an uncalled locally-declared arrow is not a registration.
                if !matches!(s.nodes().parent_kind(parent.id()),Some(AstKind::ReturnStatement(_))) {return false;}
            }
            AstKind::Function(f)=>return f.id.as_ref().and_then(|i|i.symbol_id.get()).is_some_and(|id|exposed_symbol(s,id,&mut Vec::new())),
            _=>{}
        }
    }
    true
}
fn native_main_binding(s: &Semantic<'_>) -> (&'static str,&'static str,Span) {
    let shell = match native_roles::turn_shell(s) { Ok(shell) => shell, Err(code) => return ("unsupported", code, Span::default()) };
    let mut primary = Vec::new();
    for node in s.nodes().iter() {
        let AstKind::CallExpression(c) = node.kind() else { continue; };
        let Some(host) = member(&c.callee, "createSession").and_then(|e| member(e, "inference")) else { continue; };
        if binding(host, s) != Some(shell.host) { continue; }
        if c.arguments.len() != 2 { return ("unsupported", "unclassified-shell-session", c.span); }
        let Some(options) = c.arguments[1].as_expression() else { return ("unsupported", "unclassified-shell-session", c.span); };
        if let Expression::ObjectExpression(o) = options.get_inner_expression() {
            let Some(f) = native_roles::disjoint_fields(o) else { return ("unsupported", "summary-options-unproven", o.span); };
            if f.iter().any(|(k,v)| *k == "isSummarizationSession" && matches!(v.get_inner_expression(), Expression::BooleanLiteral(b) if b.value))
                && !f.iter().any(|(k,_)| ["agentId", "invocationId", "clientNonce"].contains(k)) { continue; }
            return ("unsupported", "unclassified-shell-session", c.span);
        }
        primary.push((c, options, node.id()));
    }
    if primary.len() != 1 { return ("unsupported", "native-main-role-not-unique", Span::default()); }
    let (c, options, node) = primary[0];
    if !native_roles::main_path(s, node, &shell) { return ("unsupported", "main-trace-consumer-unproven", c.span); }
    if !unmodified(options,s) || frame(options,s) != Some(shell.run_turn_node) { return ("violated", "native-options-binding-mismatch", c.span); }
    let Some(Expression::ObjectExpression(o)) = initializer(options,s) else { return ("unsupported", "options-not-direct-object", c.span); };
    let Some(f) = native_roles::disjoint_fields(o) else { return ("unsupported", "dynamic-or-overwritten-options", o.span); };
    if !native_roles::main_identity(s, &f, &shell) { return ("violated", "native-turn-identity-mismatch", o.span); }
    if s.scoping().get_resolved_references(binding(options,s).unwrap()).count() != 1 { return ("unsupported", "options-escape", o.span); }
    ("passed", "native-main-local-wiring", c.span)
}
fn main_binding(s: &Semantic<'_>) -> (&'static str,&'static str,Span) {
    // Select the native owner before judging its fields. A correct decoy must
    // not rescue a damaged main path in a recognizable native turn shell.
    if native_roles::has_shell(s) { return native_main_binding(s); }
    let mut found=Vec::new();
    for node in s.nodes().iter() {
        if let AstKind::CallExpression(c)=node.kind() {
            if let Some(inference)=member(&c.callee,"createSession") {
                if let Some(host)=member(inference,"inference") {found.push((c,host,node.id()));}
            }
        }
    }
    if found.len()!=1 {return ("unsupported","main-call-not-unique",Span::default());}
    let (c,host,node)=found[0];let bad=("violated","main-binding-mismatch",c.span);
    if !control_path(s,node,None) || !exposed_owner(s,node) { return ("unsupported","main-control-flow-unproven",c.span); }
    if c.arguments.len()!=2 || !unmodified(host,s) {return bad;}
    let Some(options)=c.arguments[1].as_expression() else{return bad;};
    if !unmodified(options,s) || frame(options,s)!=frame(host,s) {return bad;}
    let Some(Expression::ObjectExpression(o))=initializer(options,s) else{return ("unsupported","options-not-direct-object",c.span);};
    if o.span.end>c.span.start {return ("violated","options-before-declaration",c.span);}
    let Some(f)=fields(o) else{return ("unsupported","dynamic-or-overwritten-options",o.span);};
    let get=|key|f.iter().find(|(k,_)|*k==key).map(|(_,v)|*v);
    let Some(agent)=get("agentId").and_then(call) else{return bad;};
    if !agent.arguments.is_empty() || !member(&agent.callee,"getConversationId").is_some_and(|v|same(v,host,s)) {return bad;}
    if !get("invocationId").is_some_and(|e|unmodified(e,s)&&frame(e,s)==frame(host,s)) || !get("clientNonce").and_then(|e|member(e,"clientNonce")).is_some_and(|e|unmodified(e,s)&&frame(e,s)==frame(host,s)) {return bad;}
    // Reject any use except this call: aliases, mutations through a property,
    // or escape to unknown code are outside this finite def-use proof.
    let id=binding(options,s).unwrap();
    if s.scoping().get_resolved_references(id).count()!=1 {return ("unsupported","options-escape",o.span);}
    ("passed","main-bound-no-overwrite",c.span)
}
fn one_statement<'a,'b>(stmt: &'b Statement<'a>) -> Option<&'b Statement<'a>> {
    if let Statement::BlockStatement(b)=stmt {if b.body.len()==1{return Some(&b.body[0]);}None}else{Some(stmt)}
}
fn turn_guard(s: &Semantic<'_>) -> (&'static str,&'static str,Span) {
    let functions:Vec<_>=s.nodes().iter().filter_map(|n|if let AstKind::Function(f)=n.kind(){if f.id.as_ref().is_some_and(|i|i.name=="shouldRetryTurnAttempt"){Some((f,n.id()))}else{None}}else{None}).collect();
    if functions.len()!=1{return ("unsupported","turn-policy-not-unique",Span::default());}
    let (f,node)=functions[0];let bad=("violated","guard-does-not-dominate-retry",f.span);
    let registered = f.id.as_ref().and_then(|i|i.symbol_id.get()).is_some_and(|id| {
        if native_roles::has_function(s, "createStreamAttempt") { native_roles::retry_consumer(s,id) }
        else { exposed_symbol(s,id,&mut Vec::new()) }
    });
    if !control_path(s,node,None) || !registered { return ("unsupported","retry-control-flow-unproven",f.span); }
    if f.r#async || f.generator || f.params.items.len()!=1 || f.params.rest.is_some(){return ("unsupported","turn-policy-shape",f.span);}
    let Some(body)=&f.body else{return bad;};
    if body.statements.len()<3{return bad;}
    let Statement::VariableDeclaration(decl)=&body.statements[0] else{return bad;};
    if decl.kind!=VariableDeclarationKind::Const || decl.declarations.len()!=1{return bad;}
    let d=&decl.declarations[0];let BindingPatternKind::BindingIdentifier(gate)=&d.id.kind else{return bad;};
    if !d.init.as_ref().is_some_and(|v|hook(v,"grokbox.box-runtime.managed-failure.v1",s)){return bad;}
    let Statement::IfStatement(test)=&body.statements[1] else{return bad;};
    if test.alternate.is_some(){return bad;}
    let Expression::LogicalExpression(and)=test.test.get_inner_expression() else{return bad;};
    if and.operator!=LogicalOperator::And{return bad;}
    let Expression::BinaryExpression(eq)=and.left.get_inner_expression() else{return bad;};
    let Expression::UnaryExpression(ty)=eq.left.get_inner_expression() else{return bad;};
    if eq.operator!=BinaryOperator::StrictEquality || ty.operator!=UnaryOperator::Typeof || binding(&ty.argument,s)!=gate.symbol_id.get()
        || !matches!(eq.right.get_inner_expression(),Expression::StringLiteral(v) if v.value=="function"){return bad;}
    let Some(invoke)=call(&and.right) else{return bad;};
    if binding(&invoke.callee,s)!=gate.symbol_id.get() || invoke.arguments.len()!=1{return bad;}
    let BindingPatternKind::BindingIdentifier(param)=&f.params.items[0].pattern.kind else{return ("unsupported","destructured-retry-input",f.span);};
    let Some(error)=invoke.arguments[0].as_expression().and_then(|e|member(e,"error")) else{return bad;};
    if binding(error,s)!=param.symbol_id.get(){return bad;}
    if !matches!(one_statement(&test.consequent),Some(Statement::ReturnStatement(r)) if matches!(r.argument.as_ref(),Some(Expression::BooleanLiteral(v)) if !v.value)){return bad;}
    // Finite CFG: first entry block declares the exact predicate, the next
    // positive branch terminates with false, before every remaining retry path.
    // Arbitrary conditional aliases and alternate control shapes are not proven.
    ("passed","entry-guard-terminates-managed-branch",test.span)
}
fn checkpoint(s: &Semantic<'_>) -> (&'static str,&'static str,Span) {
    let calls:Vec<_>=s.nodes().iter().filter_map(|n|if let AstKind::CallExpression(c)=n.kind(){if initializer(&c.callee,s).is_some_and(|v|hook(v,"grokbox.box-runtime.host-compact.v1",s)){Some((c,n.id()))}else{None}}else{None}).collect();
    if calls.len()!=1{return ("unsupported","compact-hook-not-unique",Span::default());}
    let (c,node)=calls[0];let bad=("violated","checkpoint-lifetime-mismatch",c.span);
    if !unmodified(&c.callee,s) || !control_path(s,node,Some(&c.callee)) || !(exposed_owner(s,node) || native_roles::checkpoint_owner(s,node)) { return ("unsupported","checkpoint-registration-unproven",c.span); }
    if c.arguments.len()!=1{return bad;}
    let Some(Expression::ObjectExpression(o))=c.arguments[0].as_expression() else{return bad;};
    let Some(f)=fields(o) else{return ("unsupported","dynamic-compact-options",o.span);};
    let get=|key|f.iter().find(|(k,_)|*k==key).map(|(_,v)|*v);
    let Some(ctx)=get("ctx") else{return bad;};let Some(state)=get("stateHandler") else{return bad;};
    if !unmodified(ctx,s) || !native_roles::method_unmodified(state,"computeNewStructure",s) || frame(ctx,s)!=frame(state,s) { return bad; }
    let Some(Expression::ArrowFunctionExpression(callback))=get("contextCheckpoint") else{return bad;};
    if !callback.r#async || callback.params.items.len()!=0 || callback.params.rest.is_some() || callback.body.statements.len()!=2{return bad;}
    let Statement::IfStatement(guard)=&callback.body.statements[0] else{return bad;};
    if guard.alternate.is_some() || !matches!(one_statement(&guard.consequent),Some(Statement::ThrowStatement(_))){return bad;}
    let Expression::BinaryExpression(eq)=guard.test.get_inner_expression() else{return bad;};
    let Expression::UnaryExpression(ty)=eq.left.get_inner_expression() else{return bad;};
    if eq.operator!=BinaryOperator::StrictInequality || ty.operator!=UnaryOperator::Typeof || !matches!(eq.right.get_inner_expression(),Expression::StringLiteral(v) if v.value=="function"){return bad;}
    let Statement::ExpressionStatement(statement)=&callback.body.statements[1] else{return bad;};
    let Expression::AwaitExpression(outer)=statement.expression.get_inner_expression() else{return bad;};
    let Some(write)=call(&outer.argument) else{return bad;};
    if !same(&write.callee,&ty.argument,s) || !unmodified(&write.callee,s) || frame(&write.callee,s)!=frame(ctx,s) || write.arguments.len()!=2{return bad;}
    let Some(arg)=write.arguments[0].as_expression() else{return bad;};if !same(arg,ctx,s){return bad;}
    let Some(Expression::AwaitExpression(inner))=write.arguments[1].as_expression() else{return bad;};
    let Some(compute)=call(&inner.argument) else{return bad;};
    if compute.arguments.len()!=1 || !member(&compute.callee,"computeNewStructure").is_some_and(|e|same(e,state,s)) || !compute.arguments[0].as_expression().is_some_and(|e|same(e,ctx,s)){return bad;}
    ("passed","compute-await-before-persist-await",callback.span)
}
/// Parse the complete input, check ECMAScript semantic diagnostics (not just
/// parser recovery), then inspect bindings and supported local control flow.
/// `candidate=false` performs strict syntax only; it never claims hook presence.
pub fn analyze(source: &str, candidate: bool, requirements: &[(String,u64)]) -> Analysis {
    let allocator=Allocator::default();
    let parsed=Parser::new(&allocator,source,SourceType::cjs()).parse();
    if parsed.panicked || !parsed.errors.is_empty(){return Analysis{valid:false,diagnostics:parsed.errors.len().max(1).min(1000000),nodes:0,findings:if candidate {requirements.iter().map(|(id,v)|finding(id,*v,"unsupported","invalid-syntax",Span::default())).collect()}else{Vec::new()}};}
    let built=SemanticBuilder::new().with_check_syntax_error(true).with_cfg(candidate).build(&parsed.program);
    let valid=built.errors.is_empty();let s=built.semantic;
    let findings=if candidate {requirements.iter().map(|(id,v)|{
        let (state,code,span)=if !valid{("unsupported","semantic-diagnostics",Span::default())}
        else if !CHECKS.contains(&(id.as_str(),*v)){("unsupported","checker-not-implemented",Span::default())}
        else{match id.as_str(){"session.main-binding"=>main_binding(&s),"retry.turn-guard"=>turn_guard(&s),"context.checkpoint-await"=>checkpoint(&s),"context.lease-finally"=>lease_lifetime::check(&s,source),_=>unreachable!()}};
        finding(id,*v,state,code,span)
    }).collect()}else{Vec::new()};
    Analysis{valid,diagnostics:built.errors.len().min(1000000),nodes:s.nodes().iter().count(),findings}
}
