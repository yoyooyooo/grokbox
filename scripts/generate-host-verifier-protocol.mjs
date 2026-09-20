import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const text=readFileSync(resolve(root,'protocols/host-verifier/v1/schema.json'),'utf8');
const schema=JSON.parse(text),digest=createHash('sha256').update(text).digest('hex');
function supported(s){
 const allowed=s.$ref?['$ref']:s.type==='object'?['type','additionalProperties','required','properties']:s.type==='array'?['type','minItems','maxItems','items']:s.type==='string'?['type','enum','minLength','maxLength']:s.type==='integer'?['type','minimum','maximum']:[];
 if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!allowed.includes(k)))throw Error('unsupported_wire_schema_feature');
 if(s.$ref){if(!/^#\/\$defs\/[A-Za-z]+$/.test(s.$ref)||!schema.$defs[s.$ref.split('/').at(-1)])throw Error('unsupported_wire_reference');return;}
 if(s.type==='object'){if(s.additionalProperties!==false||!Array.isArray(s.required)||JSON.stringify([...s.required].sort())!==JSON.stringify(Object.keys(s.properties).sort()))throw Error('unsupported_optional_wire_field');Object.values(s.properties).forEach(supported);}
 else if(s.type==='array')supported(s.items);
 else if(!['integer','string'].includes(s.type))throw Error('unsupported_wire_type');
}
Object.values(schema.$defs).forEach(supported);
const flags=process.argv.slice(2);if(flags.length>1||flags.length===1&&!['--check','--write','--print-ts','--print-rust'].includes(flags[0]))throw Error('invalid_codegen_arguments');
function ts(v){if(v.$ref)return v.$ref.split('/').at(-1);if(v.enum)return v.enum.map(x=>JSON.stringify(x)).join(' | ');if(v.type==='array')return `Array<${ts(v.items)}>`;return v.type==='integer'?'number':v.type;}
function rs(v){if(v.$ref)return v.$ref.split('/').at(-1);if(v.type==='array')return `Vec<${rs(v.items)}>`;return v.type==='integer'?'u64':v.type==='boolean'?'bool':'String';}
const tsOut=`// Generated from protocols/host-verifier/v1/schema.json. Do not edit.\nexport const SCHEMA_DIGEST = "${digest}";\n`+Object.entries(schema.$defs).map(([name,s])=>`export type ${name} = { ${Object.entries(s.properties).map(([k,v])=>`${k}: ${ts(v)}`).join('; ')} };\n`).join('');
const rsOut='// Generated from protocols/host-verifier/v1/schema.json. Do not edit.\n'+`pub const SCHEMA_DIGEST: &str = "${digest}";\n`+Object.entries(schema.$defs).map(([name,s])=>`#[derive(serde::Serialize, serde::Deserialize, Debug)]\n#[serde(deny_unknown_fields)]\npub struct ${name} {\n${Object.entries(s.properties).map(([k,v])=>`    pub ${k}: ${rs(v)},`).join('\n')}\n}\n`).join('');
const outputs=[['packages/box-runtime/src/internal/io/host-verifier/generated/protocol.ts',tsOut],['crates/host-verifier/src/bin/grokbox-host-verifier/generated/protocol.rs',rsOut]];
if(flags[0]==='--write'){for(const [path,content] of outputs)writeFileSync(resolve(root,path),content);}
else if(process.argv.includes('--print-ts'))process.stdout.write(tsOut);
else if(process.argv.includes('--print-rust'))process.stdout.write(rsOut);
else {for(const [path,content] of outputs)if(readFileSync(resolve(root,path),'utf8')!==content)throw Error(`host_verifier_codegen_drift:${path}`);console.log(JSON.stringify({ok:true,schemaDigest:digest}));}
export { schema, digest };
