import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CORE_OBSERVATION_FAMILIES, CORE_OBSERVATION_TESTS } from "../../../scripts/core-observation-manifest.mjs";

const root=resolve(import.meta.dir,"../../..");
test("E1 evidence inventory is finite, unique and executable",()=>{
 expect(CORE_OBSERVATION_TESTS.length).toBeGreaterThan(20);
 expect(CORE_OBSERVATION_TESTS.length).toBeLessThan(60);
 expect(new Set(CORE_OBSERVATION_TESTS).size).toBe(CORE_OBSERVATION_TESTS.length);
 for(const path of CORE_OBSERVATION_TESTS){expect(path.endsWith(".test.ts")).toBe(true);expect(existsSync(resolve(root,path)),path).toBe(true);}
});
test("E1 covers the pre-J2 safety concerns without claiming J3 live duration",()=>{
 const concerns=new Set(CORE_OBSERVATION_FAMILIES.flatMap(f=>f.concerns));
 for(const required of ["input","execution","error","unknown","original-record","host-health","source-missing","detector-failure","default-protection","permission","revocation","unknown-no-replay","capacity","three-maintenance-cycles","close-settlement","sigkill-restart","worker-inventory","effective-policy","native-association"]) expect(concerns.has(required),required).toBe(true);
});
test("three maintenance cycles and guarded background workers are executable evidence, not prose",()=>{
 const maintenance=readFileSync(resolve(root,"packages/box-runtime/test/storage-maintenance-lifetime.test.ts"),"utf8");
 expect(maintenance).toContain("n >= 3");
 expect(maintenance).toContain("SIGKILL");
 const server=readFileSync(resolve(root,"packages/server/src/server.ts"),"utf8");
 for(const name of ["monitor","notification-outbox","protection"]) expect(server).toContain(`name: "${name}"`);
 expect(server).toContain('installationBudgetEnforced: false');
});
