import { parseConfigJson } from "@grokbox/runtime-kernel/config";
import schema from "../../../../../../protocols/host-verifier/v1/schema.json";
export class VerifierFailure extends Error {
  readonly _tag="VerifierFailure";
  constructor(readonly code:string){super(`host_verifier_${code}`);this.name="VerifierFailure";}
}
const bad=(code:string):never=>{throw new VerifierFailure(code);};
/** Runtime decoding uses the same finite schema as the binary, not a parallel
 * handwritten list of wire fields. Cross-message identities are checked later. */
export function wireShape(name:string,value:unknown):boolean {
  const defs=schema.$defs as Record<string,any>;
  const test=(s:any,v:any):boolean=>{
    if(s.$ref)return test(defs[s.$ref.split('/').at(-1)],v);
    if(s.enum&&!s.enum.includes(v))return false;
    if(s.type==="object")return v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).length===Object.keys(s.properties).length&&Object.entries(s.properties).every(([k,p])=>Object.hasOwn(v,k)&&test(p,v[k]));
    if(s.type==="string")return typeof v==="string"&&Array.from(v).length>=(s.minLength??0)&&Array.from(v).length<=(s.maxLength??Infinity);
    if(s.type==="integer")return Number.isSafeInteger(v)&&v>=(s.minimum??0)&&v<=(s.maximum??Number.MAX_SAFE_INTEGER);
    if(s.type==="array")return Array.isArray(v)&&v.length>=(s.minItems??0)&&v.length<=(s.maxItems??Infinity)&&v.every(x=>test(s.items,x));
    return false;
  };
  return !!defs[name]&&test(defs[name],value);
}
export function encodeFrame(value:unknown):Buffer {
  const bytes=Buffer.from(JSON.stringify(value));if(bytes.length<1||bytes.length>65536)return bad("frame-limit");
  return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`),bytes]);
}
export class VerifierFrames {
  private buffer=Buffer.alloc(0);private size:number|undefined;private total=0;
  push(bytes:Buffer):unknown[]{
    this.total+=bytes.length;if(this.total>131328)return bad("output-limit");
    this.buffer=Buffer.concat([this.buffer,bytes]);const values:unknown[]=[];
    while(true){
      if(this.size===undefined){const end=this.buffer.indexOf("\r\n\r\n");if(end<0){if(this.buffer.length>128)return bad("header-limit");break;}
        if(end>124)return bad("header-limit");const header=this.buffer.subarray(0,end).toString("ascii"),match=/^Content-Length: ([1-9][0-9]{0,4})$/.exec(header);
        if(!match||Buffer.from(header,"ascii").compare(this.buffer.subarray(0,end))!==0||Number(match[1])>65536)return bad("invalid-header");
        this.size=Number(match[1]);this.buffer=this.buffer.subarray(end+4);}
      if(this.buffer.length<this.size)break;
      const body=this.buffer.subarray(0,this.size);this.buffer=this.buffer.subarray(this.size);this.size=undefined;
      try{values.push(parseConfigJson(new TextDecoder("utf-8",{fatal:true}).decode(body)));}catch{return bad("invalid-json");}
    }return values;
  }
  finish(){if(this.buffer.length||this.size!==undefined)return bad("truncated-frame");}
}
