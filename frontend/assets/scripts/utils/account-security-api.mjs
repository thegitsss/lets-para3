const knownMessages = new Map([
  ["Current password is incorrect.", "Current password is incorrect."],
  ["Choose a password you have not already used for this account.", "Choose a different new password."],
  ["Verify your email before enabling two-step verification.", "Verify your email before enabling email sign-in codes."],
  ["Authenticator setup expired. Start again.", "Authenticator setup expired. Start again."],
  ["Too many attempts. Start setup again.", "Too many attempts. Start setup again."],
  ["That code is not valid. Try the current code from your app.", "That code is not valid. Enter the current code from your app."],
  ["Passkey setup failed or expired. Start again.", "Passkey setup failed or expired. Start again."],
  ["Two-step verification is currently disabled.", "Two-step verification is currently unavailable."],
  ["Enable two-step verification before generating backup codes.", "Enable two-step verification before generating backup codes."],
  ["Session not found", "This session has already ended. Refresh the list."],
  ["Passkey not found", "This passkey has already been removed. Refresh the list."],
]);
const passwordCodes = { password_too_short:"Use at least 8 characters.",password_too_long:"Use no more than 128 characters.",password_blocklisted:"Choose a less common password or a longer, unique passphrase." };
export class SecurityError extends Error {
  constructor(kind, status=0, payload={}) {
    const passwordRequired = /^Enter your current password to (?:change two-step verification|set up an authenticator app|add a passkey|remove a passkey|generate backup codes)\.$/.test(payload.error||"");
    super(kind==="conflict" ? "Your security settings changed. Refresh them before continuing." : payload.code==="SECURITY_SESSION_REQUIRED" ? "Sign in again to identify this session before continuing." : passwordCodes[payload.code] || (passwordRequired ? "Enter your current password to continue." : knownMessages.get(payload.error)) || (kind==="uncertain" ? "The result could not be confirmed. Check the current settings before trying again." : "This security request could not be completed. Try again."));
    this.name="SecurityError";this.kind=kind;this.status=status;
    this.code=/^(?:ACCOUNT_|SECURITY_)[A-Z_]{1,60}$/.test(payload.code||"")?payload.code:passwordCodes[payload.code]?payload.code:"";
  }
}
const objectId = value => /^[a-f\d]{24}$/i.test(value||"");
const plain = value => Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
export function securityState(payload) {
  if(!plain(payload)||typeof payload.enabled!=="boolean"||!["email","authenticator"].includes(payload.method)||typeof payload.hasBackupCodes!=="boolean"||typeof payload.sessionManaged!=="boolean"||!/^[a-f\d]{64}$/.test(payload.securityRevision||""))throw new SecurityError("invalid_response");
  return {enabled:payload.enabled,method:payload.method,hasBackupCodes:payload.hasBackupCodes,disabled:payload.disabled===true,sessionManaged:payload.sessionManaged,securityRevision:payload.securityRevision};
}
const validCodes=values=>Array.isArray(values)&&values.length>0&&values.length<=50&&values.every(value=>typeof value==="string"&&/^[A-Z0-9-]{6,64}$/.test(value));

// Deliberate operations only: no automatic security write retry. Expected
// password/current-session logout is handled before a post-write owner check.
export function createSecurityApi({fetchImpl=window.fetch.bind(window),onAuthenticationLost,classifySession}={}) {
  if (typeof classifySession !== "function") throw new TypeError("A Security session classifier is required.");
  let generation=0;const pending=new Set();
  async function request(path,{signal,method="GET",body,headers={}}={}) {
    const controller=new AbortController(),ticket=generation,abort=()=>controller.abort();let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;abort();},30000);pending.add(controller);signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
    try {
      const response=await fetchImpl(path,{method,body,headers:{Accept:"application/json",...headers},credentials:"include",cache:"no-store",redirect:"error",signal:controller.signal});
      const payload=await response.json().catch(()=>null);
      if(signal?.aborted||ticket!==generation||controller.signal.aborted&&!timedOut)throw new DOMException("Canceled","AbortError");
      if(timedOut)throw new SecurityError(method==="GET"?"network":"uncertain");
      if(!response.ok) {
        const lost=response.status===401||response.status===403&&(payload?.code==="ACCOUNT_CHANGED"||/session expired|invalid token|account has been (?:deactivated|disabled)/i.test(String(payload?.error||payload?.msg||"")));
        if(lost)onAuthenticationLost?.();
        throw new SecurityError(lost?"authentication":response.status===409&&payload?.code!=="SECURITY_SESSION_REQUIRED"&&!knownMessages.has(payload?.error)?"conflict":response.status>=500&&method!=="GET"?"uncertain":"request",response.status,payload||{});
      }
      if(!plain(payload))throw new SecurityError(method==="GET"?"invalid_response":"uncertain");return payload;
    } catch(error) {
      if(signal?.aborted||ticket!==generation)throw new DOMException("Canceled","AbortError");
      if(error instanceof SecurityError)throw error;
      throw new SecurityError(method==="GET"?"network":"uncertain");
    } finally {clearTimeout(timer);pending.delete(controller);signal?.removeEventListener("abort",abort);}
  }
  async function verify(options) {
    if(!objectId(options?.ownerId))throw new SecurityError("authentication");
    const session=classifySession(await request("/api/auth/me",options));
    if(session.state!=="ready"||session.identity.id!==options.ownerId){onAuthenticationLost?.();throw new SecurityError("authentication");}
  }
  async function read(path,options) {await verify(options);const params=new URLSearchParams({expectedOwnerId:options.ownerId});if(options.cursor)params.set("cursor",options.cursor);const result=await request(`${path}?${params}`,options);await verify(options);return result;}
  async function write(path,values,options,{method="POST",maySignOut=false,success}={}) {
    await verify(options);const csrf=await request("/api/csrf",options);if(typeof csrf.csrfToken!=="string"||!csrf.csrfToken)throw new SecurityError("invalid_response");
    const result=await request(path,{...options,method,headers:{"Content-Type":"application/json","X-CSRF-Token":csrf.csrfToken},body:JSON.stringify({...values,expectedOwnerId:options.ownerId,...(options.securityRevision?{expectedSecurityRevision:options.securityRevision}:{})})});
    if(typeof success!=="function"||!success(result))throw new SecurityError("uncertain");
    if(!(maySignOut&&(result.reauthenticationRequired===true||result.currentSessionRevoked===true))) {
      try { await verify(options); }
      catch(error) {
        if(error.name==="AbortError"||error.kind==="authentication")throw error;
        // State may already have changed, including one-time recovery material.
        // Preserve the uncertain flow until an owner-verified read can settle it.
        throw new SecurityError("uncertain");
      }
    }
    return result;
  }
  return Object.freeze({
    async readState(options){return securityState(await read("/api/account/2fa",options));},
    async readSessions(options){const value=await read("/api/account/sessions",options);const valid=item=>plain(item)&&typeof item.id==="string"&&typeof item.current==="boolean";if(!Array.isArray(value.sessions)||value.sessions.some(item=>!valid(item))||value.currentSession!==null&&!valid(value.currentSession)||!(value.nextCursor===null||typeof value.nextCursor==="string")||!Number.isSafeInteger(value.total)||value.total<0)throw new SecurityError("invalid_response");return value;},
    async readPasskeys(options){const value=await read("/api/account/passkeys",options);if(!Array.isArray(value.passkeys)||value.passkeys.some(item=>!plain(item)||!objectId(item.id)||typeof item.name!=="string"))throw new SecurityError("invalid_response");return value.passkeys;},
    changePassword:(values,options)=>write("/api/account/update-password",values,options,{maySignOut:true,success:result=>result.ok===true&&result.reauthenticationRequired===true}),
    changeMfa:(values,options)=>write("/api/account/2fa-toggle",values,options,{success:result=>result.enabled===values.enabled&&result.method===(values.method||"email")}),
    beginAuthenticator:(values,options)=>write("/api/account/2fa/authenticator/setup",values,options,{success:result=>/^[\w-]{20,200}$/.test(result.challengeId||"")&&/^data:image\/png;base64,[A-Za-z0-9+/=]{1,100000}$/.test(result.qrDataUrl||"")&&/^[A-Z2-7]{16,128}$/.test(result.manualSecret||"")&&Number.isFinite(result.expiresInSeconds)&&result.expiresInSeconds>0&&result.expiresInSeconds<=600}),
    confirmAuthenticator:(values,options)=>write("/api/account/2fa/authenticator/confirm",values,options,{success:result=>result.enabled===true&&result.method==="authenticator"&&validCodes(result.backupCodes)}),
    rotateBackupCodes:(values,options)=>write("/api/account/2fa-backup-codes",values,options,{success:result=>validCodes(result.codes)}),
    beginPasskey:(values,options)=>write("/api/account/passkeys/registration-options",values,options,{success:result=>/^[\w-]{20,200}$/.test(result.challengeId||"")&&plain(result.options)}),
    registerPasskey:(values,options)=>write("/api/account/passkeys/register",values,options,{success:result=>objectId(result.id)&&typeof result.name==="string"&&result.name.length>0&&result.name.length<=80}),
    removePasskey:(id,values,options)=>{if(!objectId(id))throw new SecurityError("invalid_request");return write(`/api/account/passkeys/${encodeURIComponent(id)}`,values,options,{method:"DELETE",success:result=>result.ok===true});},
    revokeSession:(id,options)=>{if(typeof id!=="string"||! /^[\w-]{1,128}$/.test(id))throw new SecurityError("invalid_request");return write(`/api/account/sessions/${encodeURIComponent(id)}`,{},options,{method:"DELETE",maySignOut:true,success:result=>result.ok===true&&typeof result.currentSessionRevoked==="boolean"});},
    revokeOthers:options=>write("/api/account/sessions/revoke-others",{},options,{success:result=>result.ok===true&&Number.isSafeInteger(result.revokedCount)&&result.revokedCount>=0}),
    clear(){generation+=1;pending.forEach(controller=>controller.abort());pending.clear();},
  });
}
