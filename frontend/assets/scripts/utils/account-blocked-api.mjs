const id=value=>typeof value==='string'&&/^[a-f0-9]{24}$/i.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const date=value=>value===null||typeof value==='string'&&Number.isFinite(new Date(value).getTime());
export class BlockedError extends Error {
  constructor(kind,status=0){super(kind==='conflict'?'This block changed. Review the current list before trying again.':kind==='uncertain'?'The unblock result could not be confirmed. Check its current status before trying again.':'Blocked users could not be loaded. Try again.');this.name='BlockedError';this.kind=kind;this.status=status;}
}
export function blockedPage(value) {
  if(!plain(value)||!Array.isArray(value.items)||value.items.length>50||!Number.isSafeInteger(value.total)||value.total<value.items.length||!(value.nextCursor===null||typeof value.nextCursor==='string'&&value.nextCursor.length>0&&value.nextCursor.length<=1000))throw new BlockedError('invalid_response');
  const seen=new Set();const items=value.items.map(item=>{
    if(!plain(item)||!id(item.blockedId)||seen.has(item.blockedId)||!hash(item.revision)||typeof item.name!=='string'||!item.name||typeof item.role!=='string'||typeof item.reason!=='string'||!date(item.createdAt))throw new BlockedError('invalid_response');
    seen.add(item.blockedId);return{blockedId:item.blockedId,name:item.name.slice(0,240),role:item.role,reason:item.reason.slice(0,2000),createdAt:item.createdAt,revision:item.revision};
  });return{items,total:value.total,nextCursor:value.nextCursor};
}
export function blockedStatus(value,blockedId) {
  if(!plain(value)||value.blockedId!==blockedId||typeof value.blocked!=='boolean'||!(value.blocked?hash(value.revision):value.revision===null))throw new BlockedError('invalid_response');
  return{blockedId,blocked:value.blocked,revision:value.revision};
}
export function createBlockedApi({fetchImpl=window.fetch.bind(window),onAuthenticationLost,classifySession}={}) {
  if (typeof classifySession !== "function") throw new TypeError("A blocked-settings session classifier is required.");
  let generation=0;const pending=new Set();
  async function request(path,{signal,method='GET',body,headers={}}={}) {
    const ticket=generation,controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;abort();},30000);pending.add(controller);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try{
      const response=await fetchImpl(path,{method,body,headers:{Accept:'application/json',...headers},credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal});const value=await response.json().catch(()=>null);
      if(signal?.aborted||ticket!==generation||controller.signal.aborted&&!timedOut)throw new DOMException('Canceled','AbortError');
      if(timedOut)throw new BlockedError(method==='GET'?'network':'uncertain');
      if(!response.ok){const lost=response.status===401||response.status===403&&(value?.code==='ACCOUNT_CHANGED'||/session expired|invalid token|account has been (?:deactivated|disabled)/i.test(String(value?.error||value?.msg||'')));if(lost)onAuthenticationLost?.();throw new BlockedError(lost?'authentication':response.status===409?'conflict':response.status>=500&&method!=='GET'?'uncertain':'request',response.status);}
      if(!plain(value))throw new BlockedError(method==='GET'?'invalid_response':'uncertain');return value;
    }catch(error){if(signal?.aborted||ticket!==generation)throw new DOMException('Canceled','AbortError');if(error instanceof BlockedError)throw error;throw new BlockedError(method==='GET'?'network':'uncertain');}
    finally{clearTimeout(timer);pending.delete(controller);signal?.removeEventListener('abort',abort);}
  }
  async function verify(options){if(!id(options?.ownerId))throw new BlockedError('authentication');const current=classifySession(await request('/api/auth/me',options));if(current.state!=='ready'||current.identity.id!==options.ownerId){onAuthenticationLost?.();throw new BlockedError('authentication');}}
  async function read(path,options){await verify(options);const query=new URLSearchParams({expectedOwnerId:options.ownerId});if(options.cursor)query.set('cursor',options.cursor);const value=await request(`${path}?${query}`,options);await verify(options);return value;}
  return Object.freeze({
    async readPage(options){return blockedPage(await read('/api/blocks',options));},
    async readStatus(blockedId,options){if(!id(blockedId))throw new BlockedError('invalid_request');return blockedStatus(await read(`/api/blocks/${blockedId}`,options),blockedId);},
    async unblock(blockedId,revision,options){
      if(!id(blockedId)||!hash(revision))throw new BlockedError('invalid_request');await verify(options);const csrf=await request('/api/csrf',options);if(typeof csrf.csrfToken!=='string'||!csrf.csrfToken)throw new BlockedError('invalid_response');
      const result=await request(`/api/blocks/${blockedId}`,{...options,method:'DELETE',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.csrfToken},body:JSON.stringify({expectedOwnerId:options.ownerId,expectedBlockRevision:revision})});
      if(result.ok!==true||result.blocked!==false||result.blockedId!==blockedId)throw new BlockedError('uncertain');
      try { await verify(options); }
      catch(error) {
        if(error.name==='AbortError'||error.kind==='authentication')throw error;
        // The mutation has been acknowledged. A failed identity refresh cannot
        // turn that result into a known rejection or invite a second deletion.
        throw new BlockedError('uncertain');
      }
      return result;
    },
    clear(){generation++;pending.forEach(controller=>controller.abort());pending.clear();},
  });
}
