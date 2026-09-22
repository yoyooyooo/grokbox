import { DESKTOP_POLICY, DESKTOP_SHA, DESKTOP_UUID, desktopData, type DesktopView, type DesktopPolicyReceipt } from "@grokbox/runtime-kernel/desktop";
const n=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const reasons=[null,"protected","dark","fresh-display","recent-transcript","grok","task","busy-marker","start-window","source-incomplete","ambiguous-seat"];
const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=128&&v.every(s=>typeof s==="string"&&DESKTOP_UUID.test(s)&&s===s.toLowerCase())&&new Set(v).size===v.length;
export function desktopView(value:unknown,installation:string):value is DesktopView{
  try{const r=desktopData(value,["installationId","state","observedAtMs","revision","configRevision","canPrune","automatic","worker","keepAgentIds","floorAgentIds","minIdleMs","displays","coverage","atomicSeatLease"]);
    if(r.installationId!==installation||!['ready','unavailable'].includes(r.state as string)||!n(r.observedAtMs,1)||typeof r.canPrune!=="boolean"||typeof r.automatic!=="boolean"||!["waiting","working","unavailable","stopped"].includes(r.worker as string)
      ||!ids(r.keepAgentIds)||!ids(r.floorAgentIds)||!n(r.minIdleMs,600000,86400000)||r.coverage!=="local-desktop-observation"||r.atomicSeatLease!==false||!Array.isArray(r.displays)||r.displays.length>DESKTOP_POLICY.maxSeats)return false;
    if(r.configRevision!==null&&(typeof r.configRevision!=="string"||!DESKTOP_SHA.test(r.configRevision)))return false;
    if(r.state==="ready"?(typeof r.revision!=="string"||!DESKTOP_SHA.test(r.revision)||r.configRevision===null):(r.revision!==null||r.canPrune!==false))return false;
    const seen=new Set<string>();for(const v of r.displays){const row=desktopData(v,["display","agentId","lit","idle","protected","busyReason","identity"]);
      if(!n(row.display,1,65535)||typeof row.agentId!=="string"||!DESKTOP_UUID.test(row.agentId)||seen.has(row.agentId)||[row.lit,row.idle,row.protected].some(x=>typeof x!=="boolean")||!reasons.includes(row.busyReason as never)||row.identity!==null&&(typeof row.identity!=="string"||!DESKTOP_SHA.test(row.identity)))return false;
      if(row.idle===true&&(row.lit!==true||row.protected!==false||row.busyReason!==null||row.identity===null||row.display<=1||r.state!=="ready"))return false;
      if(row.display===1&&row.protected!==true)return false;seen.add(row.agentId);
    }
    return true;
  }catch{return false;}
}
export function desktopPolicyReceipt(value:unknown,requestId:string,expectedRevision?:string):value is DesktopPolicyReceipt{
  try{const r=desktopData(value,["version","requestId","state","beforeRevision","revision","changedPaths","application"]);
    return r.version===1&&r.requestId===requestId&&["succeeded","unknown"].includes(r.state as string)&&typeof r.beforeRevision==="string"&&DESKTOP_SHA.test(r.beforeRevision)&&typeof r.revision==="string"&&DESKTOP_SHA.test(r.revision)
      &&(expectedRevision===undefined||r.beforeRevision===expectedRevision)&&r.application==="not-observed"&&Array.isArray(r.changedPaths)&&r.changedPaths.length<=130&&r.changedPaths.every(x=>typeof x==="string"&&/^\/?desktop(?:[./]|$)/.test(x)&&x.length<=256);
  }catch{return false;}
}
