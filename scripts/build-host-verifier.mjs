import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync,readdirSync,mkdirSync,copyFileSync,chmodSync,writeFileSync,existsSync } from 'node:fs';
import { join,relative,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export const VERIFIER_TARGET='x86_64-unknown-linux-gnu';
export function verifierSourceDigest(root){
  const paths=['Cargo.toml','Cargo.lock','rust-toolchain.toml','scripts/build-host-verifier.mjs','scripts/generate-host-verifier-protocol.mjs'];
  function walk(dir){for(const e of readdirSync(join(root,dir),{withFileTypes:true})){const p=`${dir}/${e.name}`;if(e.isDirectory())walk(p);else if(e.isFile())paths.push(p);else throw Error('verifier_source_alias');}}
  walk('crates/host-verifier');walk('protocols/host-verifier');
  const h=createHash('sha256');for(const p of paths.sort())h.update(p+'\0').update(readFileSync(join(root,p))).update('\0');return h.digest('hex');
}
export function buildHostVerifier(root){
  if(process.platform!=='linux'||process.arch!=='x64')throw Error('host_verifier_target_not_qualified');
  execFileSync(process.execPath,['scripts/generate-host-verifier-protocol.mjs','--check'],{cwd:root,stdio:'pipe'});
  const buildId=verifierSourceDigest(root),folder=join(root,'dist/native',VERIFIER_TARGET),binary=join(folder,'grokbox-host-verifier'),manifestPath=join(folder,'verifier-manifest.json'),noticesPath=join(folder,'LICENSES.txt');
  if(existsSync(manifestPath)&&existsSync(binary)){
    const old=JSON.parse(readFileSync(manifestPath));if(old.build_id===buildId&&old.binary_sha256===createHash('sha256').update(readFileSync(binary)).digest('hex')&&existsSync(noticesPath)&&old.license_notices_sha256===createHash('sha256').update(readFileSync(noticesPath)).digest('hex'))return old;
  }
  const rust=execFileSync('rustc',['--version'],{encoding:'utf8'}).trim();if(!rust.startsWith('rustc 1.85.0 '))throw Error('host_verifier_toolchain_mismatch');
  execFileSync('cargo',['build','--locked','--release','--target',VERIFIER_TARGET,'--bin','grokbox-host-verifier'],{cwd:root,stdio:'pipe',timeout:180000,maxBuffer:8*1024*1024,env:{...process.env,GROKBOX_VERIFIER_BUILD_ID:buildId}});
  if(verifierSourceDigest(root)!==buildId)throw Error('host_verifier_source_changed');
  mkdirSync(folder,{recursive:true});copyFileSync(join(root,'target',VERIFIER_TARGET,'release/grokbox-host-verifier'),binary);chmodSync(binary,0o755);
  const identity=JSON.parse(execFileSync(binary,['--identity'],{encoding:'utf8',timeout:5000,env:{}}));
  if(identity.build_id!==buildId)throw Error('host_verifier_build_mismatch');
  const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}));
  const packages=metadata.packages.filter(p=>p.name!=='grokbox-host-verifier').sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  const licenses=[],parts=['Bundled Rust verifier dependency notices\n==========================================\n'];
  for(const p of packages){
    const base=dirname(p.manifest_path),found=[];
    for(const entry of readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.isFile()&&/^(licen[cs]e|notice|copyright|copying)([._-]|$)/i.test(entry.name))found.push(entry.name);
      if(entry.isDirectory()&&/^licenses?$/i.test(entry.name))for(const nested of readdirSync(join(base,entry.name),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)))if(nested.isFile())found.push(`${entry.name}/${nested.name}`);
    }
    // Oxc 0.75.0 crate archives omit the repository's MIT file. The exact
    // upstream revision in each archive must match the vendored notice; never
    // substitute a generic license based only on an SPDX string or crate name.
    let upstreamNotice;
    if(!found.length && p.name.startsWith('oxc_') && p.version==='0.75.0' && p.license==='MIT' && p.repository==='https://github.com/oxc-project/oxc'){
      const vcs=JSON.parse(readFileSync(join(base,'.cargo_vcs_info.json'),'utf8'));
      if(vcs.git?.sha1!=='d25dc35b19971ee19dcc1645a19b3044283d18ea')throw Error('verifier_notice_source_mismatch');
      upstreamNotice=readFileSync(join(root,'crates/host-verifier/licenses/oxc-0.75.0-MIT.txt'),'utf8');
      found.push('upstream/LICENSE@d25dc35b19971ee19dcc1645a19b3044283d18ea');
    }
    if(!found.length && p.name==='oxc_index' && p.version==='3.1.0' && p.license==='MIT' && p.repository==='https://github.com/oxc-project/oxc-index-vec'){
      const vcs=JSON.parse(readFileSync(join(base,'.cargo_vcs_info.json'),'utf8'));
      if(vcs.git?.sha1!=='5a337f7d5c01044e080c7da8d1fa04807356fc94')throw Error('verifier_notice_source_mismatch');
      // Independently retrieved at this exact revision; its LICENSE bytes are
      // identical to the pinned Oxc repository notice above.
      upstreamNotice=readFileSync(join(root,'crates/host-verifier/licenses/oxc-0.75.0-MIT.txt'),'utf8');
      found.push('upstream/LICENSE@5a337f7d5c01044e080c7da8d1fa04807356fc94');
    }
    if(!p.license||!found.length)throw Error(`verifier_dependency_notice_missing:${p.name}`);
    licenses.push({name:p.name,version:p.version,license:p.license,notice_files:found});
    parts.push(`\n${p.name} ${p.version}\nDeclared license: ${p.license}\n`);
    for(const file of found){const bytes=upstreamNotice?Buffer.from(upstreamNotice):readFileSync(join(base,file));if(bytes.length>262144)throw Error('verifier_notice_limit');parts.push(`\n--- ${file} ---\n${bytes.toString('utf8')}\n`);}
  }
  const notices=parts.join('');writeFileSync(noticesPath,notices,{mode:0o644});
  const manifest={...identity,target:VERIFIER_TARGET,rustc:'1.85.0',binary_sha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),binary_bytes:readFileSync(binary).length,license_notices_sha256:createHash('sha256').update(notices).digest('hex'),licenses};
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o644});return manifest;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])console.log(JSON.stringify(buildHostVerifier(fileURLToPath(new URL('../',import.meta.url)))));
