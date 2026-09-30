import { node, page, link, button } from "./dom.mjs";
import { accountNavigation } from "./account-navigation.mjs";

export function isSecurityRoute(route) {
  return route.query.get("tab")==="security" || /^(?:security(?::(?:password|verification|passkeys|sessions))?|attorneySecurityHeading|twoFactor|sessions|passkeys)$/.test(route.query.get("settingsTarget")||route.query.get("panel")||"");
}
const field=(label,control,hint="")=>node("div",{className:"av2-account-field"},[node("label",{for:control.id,text:label}),control,...(hint?[node("small",{text:hint})]:[])]);
const date=value=>{const parsed=new Date(value);return value&&Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat("en-US",{dateStyle:"medium",timeStyle:"short"}).format(parsed):"Date unavailable";};
function device(ua="") {
  const source=String(ua).toLowerCase();
  const browser=/edg/.test(source)?"Edge":/firefox/.test(source)?"Firefox":/chrome|crios/.test(source)?"Chrome":/safari/.test(source)?"Safari":"Browser";
  const system=/iphone|ipad/.test(source)?"iOS":/android/.test(source)?"Android":/windows/.test(source)?"Windows":/mac os/.test(source)?"macOS":/linux/.test(source)?"Linux":"device";
  return `${browser} on ${system}`;
}

export function createSecurityView(route,identity,{securityApi,signal,privateState,onSessionLost}={}) {
  const view=page("Profile Settings");view.classList.add("av2-account","av2-security");
  const ownerId=identity.id,options={ownerId,signal},accountState=privateState.account;
  const nav=accountNavigation("security");
  const notice=node("p",{className:"av2-account-feedback",role:"status","data-security-notice":""});
  const content=node("div",{"data-security-content":"","aria-busy":"true"});
  const refresh=button("Retry security",()=>{view.readiness=load();},"av2-refresh");refresh.hidden=true;view.append(nav,notice,content);
  let state=null,passkeys=null,sessions=null,errors={},loading=false,mutating=false,loadGeneration=0,dialogNumber=0,returnFocus=null;
  const dialogs=new Set();const active=()=>!signal.aborted;
  const guarded=()=>({...options,securityRevision:state?.securityRevision});
  const supported=()=>Boolean(window.isSecureContext&&window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn?.());
  function setNotice(text,isError=false){if(!active())return;notice.textContent=text;notice.dataset.state=isError?"error":"saved";}
  function clearSecretElements(root){root.querySelectorAll("input").forEach(input=>{input.value="";});root.querySelectorAll("[data-security-secret]").forEach(element=>{element.textContent="";element.removeAttribute("src");});}
  signal.addEventListener("abort",()=>{
    loadGeneration+=1;window.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony?.();
    dialogs.forEach(dialog=>{clearSecretElements(dialog);dialog.close("interrupted");dialog.remove();});dialogs.clear();clearSecretElements(view);
  },{once:true});
  function lock(value){mutating=value;refresh.disabled=value||loading;content.querySelectorAll("button").forEach(control=>{control.disabled=value||loading||control.dataset.unavailable==="true";});}
  function action(label,callback,{unavailable=false,className="av2-secondary"}={}){const control=button(label,callback,className);control.dataset.unavailable=String(unavailable);control.disabled=unavailable||mutating||loading;return control;}
  function focusTarget(control){if(!control||!view.contains(control))return null;return{source:control,section:control.closest(".av2-security-section")?.id||"",key:control.dataset.securityAction||"",label:control.getAttribute("aria-label")||control.textContent};}
  function restoreFocus(target){
    if(!active()||!view.isConnected||dialogs.size||!target)return;
    const scope=target.section?view.querySelector(`#${target.section}`):view;
    if(!scope)return;
    const control=target.source?.isConnected&&!target.source.disabled?target.source:[...scope.querySelectorAll("button:not(:disabled)")].find(item=>target.key?item.dataset.securityAction===target.key:(item.getAttribute("aria-label")||item.textContent)===target.label);
    const destination=control||scope.querySelector("h2")||view.querySelector("h1");if(!control)destination.setAttribute("tabindex","-1");destination.focus();
  }
  function section(title,id,children=[]){return node("section",{className:"av2-security-section",id:`av2-security-${id}`,"aria-labelledby":`av2-security-${id}-title`},[node("h2",{id:`av2-security-${id}-title`,text:title}),...children]);}
  function errorRow(text,retry){return node("div",{className:"av2-security-error"},[node("p",{text}),action("Retry",retry)]);}
  function modal(title,launcher,copy="") {
    const id=`av2-security-dialog-${++dialogNumber}`,target=focusTarget(launcher);
    const dialog=node("dialog",{className:"av2-account-dialog av2-security-dialog","aria-labelledby":id},[node("h2",{id,text:title}),...(copy?[node("p",{className:"av2-muted",text:copy})]:[])]);
    let busy=false;dialog.busy=value=>{busy=value;dialog.querySelectorAll("button,input").forEach(control=>{control.disabled=value;});};
    dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
    dialog.addEventListener("close",()=>{clearSecretElements(dialog);dialogs.delete(dialog);dialog.remove();if(active()){returnFocus=target;if(!loading){restoreFocus(target);returnFocus=null;}}},{once:true});
    document.body.append(dialog);dialogs.add(dialog);return dialog;
  }
  function password(label,id,autocomplete="current-password") {
    const control=node("input",{id,name:id,type:"password",autocomplete,required:"",maxlength:"128"});
    const toggle=button("Show",()=>{const show=control.type==="password";control.type=show?"text":"password";toggle.textContent=show?"Hide":"Show";toggle.setAttribute("aria-label",`${show?"Hide":"Show"} ${label.toLowerCase()}`);},"av2-security-reveal");toggle.setAttribute("aria-label",`Show ${label.toLowerCase()}`);
    return {control,element:node("div",{className:"av2-account-field"},[node("label",{for:id,text:label}),node("div",{className:"av2-security-password"},[control,toggle])])};
  }
  async function load({message="",isError=false}={}) {
    if(!active()||mutating)return;const priorFocus=focusTarget(document.activeElement);loading=true;lock(false);content.setAttribute("aria-busy","true");const ticket=++loadGeneration;
    if(!state&&!passkeys&&!sessions)content.replaceChildren(node("p",{className:"av2-muted",role:"status",text:"Loading security settings…"}));
    const results=await Promise.allSettled([securityApi.readState(options),securityApi.readPasskeys(options),securityApi.readSessions(options)]);
    if(!active()||ticket!==loadGeneration)return;
    errors={};for(let index=0;index<results.length;index++){const result=results[index],key=["state","passkeys","sessions"][index];if(result.status==="rejected")errors[key]=true;else if(key==="state")state=result.value;else if(key==="passkeys")passkeys=result.value;else sessions=result.value;}
    loading=false;refresh.disabled=false;render();content.setAttribute("aria-busy","false");restoreFocus(returnFocus||priorFocus);returnFocus=null;
    setNotice(message||accountState.securityNotice||"",isError||Boolean(accountState.securityNotice));
    const target=route.query.get("settingsTarget")||route.query.get("panel")||"";
    if(target&&!message){const key=target.includes(":")?target.split(":")[1]:target==="twoFactor"?"verification":target;const targetSection=["password","verification","sessions","passkeys"].includes(key)?view.querySelector(`#av2-security-${key}`):null;if(targetSection)requestAnimationFrame(()=>{if(active()&&view.isConnected)targetSection.querySelector("button:not(:disabled)")?.focus();});}
  }
  function render(){content.replaceChildren(...(errors.state?[errorRow("Security status could not be checked. Try again before making changes.",()=>{view.readiness=load();})]:[]),passwordSection(),verificationSection(),passkeySection(),sessionsSection());}
  async function uncertain(actionName,error,dialog) {
    dialog?.close("unconfirmed");lock(false);
    const text=actionName==="backup codes"?"Backup codes may have changed. If you did not save the new codes, generate a new set.":actionName==="authenticator setup"?"Authenticator setup could not be confirmed. Review the current method below. If enabled, generate backup codes before signing out.":error.kind==="conflict"?"Your security settings changed. Review the current settings before trying again.":`The ${actionName} result could not be confirmed. Review the current settings before trying again.`;
    accountState.securityNotice=text;await load({message:text,isError:true});
  }
  function passwordAction({title,copy,confirmLabel,launcher,onConfirm,actionName=title.toLowerCase(),needsPassword=true,extraFields=[]}) {
    const review=guarded(),dialog=modal(title,launcher,copy),form=node("form"),status=node("p",{className:"av2-account-feedback",role:"status"});
    const current=needsPassword?password("Current password",`av2-security-password-${dialogNumber}`):null;
    const cancel=button("Cancel",()=>dialog.close("cancel"));const submit=node("button",{type:"submit",className:"av2-button",text:confirmLabel});
    if(current)form.append(current.element,link("Forgot password?","/forgot-password.html"));extraFields.forEach(item=>form.append(item));
    form.append(status,node("div",{className:"av2-actions"},[cancel,submit]));dialog.append(form);
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(mutating||!active()||!form.reportValidity())return;
      if(!state||errors.state){status.textContent="Refresh security settings before continuing.";return;}
      dialog.busy(true);lock(true);status.textContent="Working…";accountState.securityNotice=`The ${actionName} result needs review if you leave this page before it finishes.`;
      try {
        const after=await onConfirm(current?.control.value||"",dialog,form,review);
        if(!active())return;delete accountState.securityNotice;dialog.close("saved");lock(false);if(after)await after();
      } catch(error) {
        if(!active()||error.name==="AbortError")return;
        if(error.kind==="uncertain"||error.kind==="conflict") {await uncertain(actionName,error,dialog);return;}
        delete accountState.securityNotice;status.textContent=error.message||"This change could not be completed. Try again.";status.dataset.state="error";
        if(current){current.control.value="";current.control.focus();}
      } finally {if(active()){lock(false);if(dialog.isConnected)dialog.busy(false);}}
    });dialog.showModal();(current?.control||submit).focus();return dialog;
  }
  function passwordSection() {
    const change=action("Change password",()=>{
      const next=password("New password","av2-security-new-password","new-password"),confirm=password("Confirm new password","av2-security-confirm-password","new-password");next.control.minLength=8;
      const hint=node("p",{className:"av2-muted",text:"Use 8–128 characters. A long, unique passphrase works well."});
      const dialog=passwordAction({title:"Change password",copy:"Changing your password signs you out on every device, including this one.",confirmLabel:"Change password and sign out",launcher:change,actionName:"password change",extraFields:[next.element,confirm.element,hint],onConfirm:async(currentPassword,_dialog,_form,review)=>{
        if(next.control.value.normalize("NFC")!==confirm.control.value.normalize("NFC")){confirm.control.setCustomValidity("The new passwords do not match.");confirm.control.reportValidity();const error=new Error("The new passwords do not match.");throw error;}
        try{const result=await securityApi.changePassword({currentPassword,newPassword:next.control.value},review);if(result.reauthenticationRequired!==true)throw Object.assign(new Error("The password result could not be confirmed."),{kind:"uncertain"});return()=>onSessionLost?.();}
        catch(error){if(error.kind!=="uncertain")throw error;clearSecretElements(dialog);dialog.close("unconfirmed");lock(false);content.replaceChildren(section("Sign in again","reauthenticate",[node("p",{text:"The password change could not be confirmed. Sign in with your new password; if it does not work, use your previous password or reset it."}),action("Sign in",()=>onSessionLost?.()),link("Reset password","/forgot-password.html")]));refresh.disabled=true;throw Object.assign(error,{name:"AbortError"});}
      }});const validateMatch=()=>confirm.control.setCustomValidity(confirm.control.value&&next.control.value.normalize("NFC")!==confirm.control.value.normalize("NFC")?"The new passwords do not match.":"");confirm.control.addEventListener("input",validateMatch);next.control.addEventListener("input",validateMatch);
    },{unavailable:!state||errors.state});
    const passwordSection=section("Password","password",[change]);passwordSection.classList.add("av2-security-password-section");return passwordSection;
  }
  function verificationSection() {
    const unavailable=!state||errors.state||state.disabled||!state.sessionManaged,method=state?.method;
    const email=action(state?.enabled&&state.method==="email"?"Enabled":"Enable email codes",()=>passwordAction({title:"Enable email sign-in codes",copy:state?.enabled?"Email codes will replace your authenticator app. Other sessions will be signed out.":"A code will be required when you sign in. Other sessions will be signed out.",confirmLabel:"Enable email codes",launcher:email,actionName:"two-step verification",onConfirm:async(currentPassword,_dialog,_form,review)=>{await securityApi.changeMfa({enabled:true,method:"email",currentPassword},review);return()=>load({message:"Email sign-in codes enabled."});}}),{unavailable:unavailable||state?.enabled&&state.method==="email"});
    const authenticator=action(state?.enabled&&state.method==="authenticator"?"Replace authenticator":"Set up authenticator",()=>passwordAction({title:"Set up authenticator",copy:"Use an authenticator app for sign-in codes. Your current method stays active until you confirm setup.",confirmLabel:"Continue",launcher:authenticator,actionName:"authenticator setup",onConfirm:async(currentPassword,_dialog,_form,review)=>{const setup=await securityApi.beginAuthenticator({currentPassword},review);return()=>authenticatorDialog(setup,authenticator,review);}}),{unavailable});
    email.dataset.securityAction="email-mfa";authenticator.dataset.securityAction="authenticator";
    const items=[node("div",{className:"av2-security-row"},[node("div",{},[node("h3",{text:"Email"}),node("p",{className:"av2-muted",text:"Receive a code at your verified email address."})]),email]),node("div",{className:"av2-security-row"},[node("div",{},[node("h3",{text:"Authenticator app"}),node("p",{className:"av2-muted",text:state?.enabled&&state.method==="authenticator"?"Your active sign-in method.":"Works without email delivery."})]),authenticator])];
    if(state?.disabled)items.unshift(node("p",{className:"av2-muted",text:"Two-step verification is currently unavailable."}));
    else if(state&&!state.sessionManaged)items.unshift(node("p",{className:"av2-muted"},[document.createTextNode("Sign in again to identify this session before changing two-step verification. "),action("Sign in again",()=>onSessionLost?.())]));
    if(state?.enabled&&!state.disabled){const backup=action(state.hasBackupCodes?"Generate new backup codes":"Generate backup codes",()=>passwordAction({title:"Generate backup codes",copy:"Any previous backup codes will stop working. Save the new codes before closing the next screen.",confirmLabel:"Generate codes",launcher:backup,actionName:"backup codes",onConfirm:async(currentPassword,_dialog,_form,review)=>{const result=await securityApi.rotateBackupCodes({currentPassword},review);return async()=>{showCodes(result.codes,backup);await load();};}}),{unavailable});const off=action("Turn off two-step verification",()=>passwordAction({title:"Turn off two-step verification?",copy:"Sign-in codes and backup codes will stop working. Other sessions will be signed out. You can still sign in with your password or an existing passkey.",confirmLabel:"Turn off",launcher:off,actionName:"two-step verification",onConfirm:async(currentPassword,_dialog,_form,review)=>{await securityApi.changeMfa({enabled:false,method,currentPassword},review);return()=>load({message:"Two-step verification turned off."});}}),{unavailable,className:"av2-security-danger"});backup.dataset.securityAction="backup-codes";off.dataset.securityAction="disable-mfa";items.push(node("div",{className:"av2-security-footer"},[backup,off]));}
    return section("Two-step verification","verification",items);
  }
  function authenticatorDialog(enrollment,launcher,snapshot) {
    if(!active())return;const dialog=modal("Connect your authenticator app",launcher,"Scan the QR code or enter the key in your app, then enter its current six-digit code.");
    const qr=node("img",{className:"av2-security-qr",src:enrollment.qrDataUrl,alt:"Authenticator setup QR code","data-security-secret":""});
    const secret=node("code",{className:"av2-security-secret",text:enrollment.manualSecret,"data-security-secret":""});
    const form=node("form"),code=node("input",{id:"av2-security-authenticator-code",name:"one-time-code",inputmode:"numeric",autocomplete:"one-time-code",pattern:"[0-9]{6}",maxlength:"6",required:""});
    const status=node("p",{role:"status",className:"av2-account-feedback"}),cancel=button("Cancel",()=>dialog.close("cancel")),submit=node("button",{type:"submit",className:"av2-button",text:"Confirm authenticator"});
    const expiresAt=Date.now()+enrollment.expiresInSeconds*1000;enrollment.manualSecret="";enrollment.qrDataUrl="";
    dialog.append(qr,node("details",{className:"av2-security-manual"},[node("summary",{text:"Enter the key manually"}),secret]));form.append(field("Six-digit code",code),status,node("div",{className:"av2-actions"},[cancel,submit]));dialog.append(form);
    const expired=()=>{if(!dialog.isConnected)return;submit.disabled=true;code.disabled=true;clearSecretElements(dialog);status.textContent="Authenticator setup expired. Close this screen and start again.";};
    const timer=setTimeout(expired,enrollment.expiresInSeconds*1000);dialog.addEventListener("close",()=>clearTimeout(timer),{once:true});
    form.addEventListener("submit",async event=>{event.preventDefault();if(mutating||!form.reportValidity())return;if(Date.now()>=expiresAt){expired();return;}lock(true);dialog.busy(true);status.textContent="Confirming…";accountState.securityNotice="Authenticator setup may have completed. Review the current method and generate backup codes if you did not save them.";
      try{const result=await securityApi.confirmAuthenticator({challengeId:enrollment.challengeId,code:code.value},snapshot);if(!active())return;delete accountState.securityNotice;dialog.close("confirmed");lock(false);showCodes(result.backupCodes,launcher);await load({message:"Authenticator enabled."});}
      catch(error){if(!active()||error.name==="AbortError")return;if(error.kind==="uncertain"||error.kind==="conflict"){await uncertain("authenticator setup",error,dialog);return;}delete accountState.securityNotice;status.textContent=error.message;status.dataset.state="error";code.value="";if(error.status===429||/expired|Start setup again/.test(error.message)){clearSecretElements(dialog);code.disabled=true;submit.disabled=true;}}
      finally{if(active()){lock(false);if(dialog.isConnected){dialog.busy(false);if(Date.now()>=expiresAt||/expired|Too many attempts/.test(status.textContent)){code.disabled=true;submit.disabled=true;}else code.focus();}}}
    });dialog.showModal();code.focus();
  }
  function showCodes(values,launcher) {
    if(!active())return;const dialog=modal("Save your backup codes",launcher,"Each code works once. LPC will not show this set again. Store them somewhere secure before closing.");
    const codes=node("pre",{className:"av2-security-codes",tabindex:"0","data-security-secret":"",text:values.join("\n")});values.fill("");
    const status=node("p",{role:"status",className:"av2-account-feedback"});
    const copy=button("Copy codes",async()=>{try{await navigator.clipboard.writeText(codes.textContent);if(active()&&dialog.isConnected)status.textContent="Copied.";}catch{status.textContent="Copy is unavailable. Select the codes to copy them.";const range=document.createRange();range.selectNodeContents(codes);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);codes.focus();}});
    const download=button("Download codes",()=>{const url=URL.createObjectURL(new Blob([`LPC backup codes\n\n${codes.textContent}\n`],{type:"text/plain"}));const anchor=node("a",{href:url,download:"lpc-backup-codes.txt"});anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);});
    const done=button("Done",()=>dialog.close("done"),"av2-button");dialog.append(codes,status,node("div",{className:"av2-actions"},[copy,download,done]));dialog.showModal();done.focus();
  }
  function passkeySection() {
    const unavailable=!state||errors.state||errors.passkeys||!passkeys||!state.sessionManaged;
    const items=[];if(errors.passkeys)items.push(errorRow(passkeys?`Passkeys could not be refreshed.${passkeys.length?" The previous list is shown below.":""}`:"Passkeys could not be loaded.",()=>{view.readiness=load();}));
    if(passkeys&&!passkeys.length&&!errors.passkeys)items.push(node("p",{className:"av2-muted",text:errors.state ? "No passkeys are recorded. Security changes are unavailable until the security status loads." : "No passkeys added."}));
    for(const item of passkeys||[]){const remove=action("Remove",()=>passwordAction({title:`Remove ${item.name||"passkey"}?`,copy:"This passkey will no longer sign in to your account.",confirmLabel:"Remove passkey",launcher:remove,actionName:"passkey removal",onConfirm:async(currentPassword,_dialog,_form,review)=>{await securityApi.removePasskey(item.id,{currentPassword},review);return()=>load({message:"Passkey removed."});}}),{unavailable});remove.setAttribute("aria-label",`Remove ${item.name||"passkey"}`);items.push(node("article",{className:"av2-security-row"},[node("div",{},[node("h3",{text:item.name||"Passkey"}),node("p",{className:"av2-muted",text:item.lastUsedAt?`Last used ${date(item.lastUsedAt)}`:`Added ${date(item.createdAt)}`})]),remove]));}
    const add=action("Add passkey",()=>{const name=node("input",{id:"av2-security-passkey-name",name:"passkey-name",maxlength:"80",autocomplete:"off"});
      passwordAction({title:"Add passkey",copy:"Use your device screen lock, fingerprint, face, or security key.",confirmLabel:"Continue on this device",launcher:add,actionName:"passkey setup",extraFields:[field("Name (optional)",name)],onConfirm:async(currentPassword,_dialog,_form,review)=>{
        const snapshot=review,registration=await securityApi.beginPasskey({currentPassword},snapshot);
        let response;try{response=await window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:registration.options});}catch(error){if(error.name==="NotAllowedError"||error.name==="AbortError")throw new Error("Passkey setup was canceled. You can try again.");throw new Error("This device could not create a passkey. Try again or use another supported device.");}
        if(!active())throw new DOMException("Canceled","AbortError");await securityApi.registerPasskey({challengeId:registration.challengeId,response,name:name.value.trim()||"Passkey"},snapshot);return()=>load({message:"Passkey added."});
      }});
    },{unavailable:unavailable||!supported()});
    items.push(node("div",{className:"av2-security-footer"},[add,...(!supported()?[node("p",{className:"av2-muted",text:"Passkey setup is unavailable on this browser or device. You can still remove an existing passkey."})]:[])]));
    return section("Passkeys","passkeys",items);
  }
  function sessionsSection() {
    const unavailable=!state||errors.state||errors.sessions||!sessions;const items=[];
    if(errors.sessions)items.push(errorRow(sessions?`Sessions could not be refreshed.${sessions.currentSession||sessions.sessions?.length?" The previous list is shown below.":""}`:"Sessions could not be loaded.",()=>{view.readiness=load();}));
    function row(item,current=false){const revoke=action(current?"Sign out":"Sign out device",()=>passwordAction({title:current?"Sign out of this device?":`Sign out ${device(item.ua)}?`,copy:current?"You will return to sign in.":"This device will need to sign in again to access LPC.",confirmLabel:current?"Sign out":"Sign out device",launcher:revoke,actionName:"session sign-out",needsPassword:false,onConfirm:async()=>{const result=await securityApi.revokeSession(item.id,options);return()=>result.currentSessionRevoked?onSessionLost?.():load({message:"Device signed out."});}}),{unavailable});if(!current)revoke.setAttribute("aria-label",`Sign out ${device(item.ua)} added ${date(item.createdAt)}`);return node("article",{className:"av2-security-row","data-security-session":item.id},[node("div",{},[node("h3",{text:current?`${device(item.ua)} · This device`:device(item.ua)}),node("p",{className:"av2-muted",text:`Last active ${date(item.lastSeenAt||item.createdAt)}`}),...(item.ip?[node("p",{className:"av2-muted",text:`IP address ${String(item.ip).slice(0,128)}`})]:[])]),revoke]);}
    if(sessions?.currentSession)items.push(row(sessions.currentSession,true));
    else if(sessions&&!errors.sessions)items.push(node("p",{className:"av2-muted",text:"This sign-in does not have a managed session. Sign in again to manage other devices safely."}));
    for(const item of sessions?.sessions||[])if(item.id!==sessions?.currentSession?.id)items.push(row(item));
    if(sessions?.nextCursor){const more=action("Load more devices",async()=>{more.disabled=true;const ticket=loadGeneration,cursor=sessions.nextCursor,priorIds=new Set(sessions.sessions.map(item=>item.id));try{const next=await securityApi.readSessions({...options,cursor});if(!active()||ticket!==loadGeneration||sessions.nextCursor!==cursor)return;sessions={...next,sessions:[...sessions.sessions,...next.sessions.filter(item=>!priorIds.has(item.id))]};const oldSection=more.closest("section");oldSection.replaceWith(sessionsSection());const newlyAdded=content.querySelectorAll("[data-security-session]");[...newlyAdded].find(item=>!priorIds.has(item.dataset.securitySession)&&item.dataset.securitySession!==sessions.currentSession?.id)?.querySelector("button")?.focus();}catch(error){if(active()&&ticket===loadGeneration){setNotice("More devices could not be loaded. Try again.",true);more.disabled=false;}}},{unavailable});items.push(more);}
    if(sessions?.currentSession&&sessions.total>1){const others=action("Sign out other devices",()=>passwordAction({title:"Sign out other devices?",copy:"This device stays signed in. All other active sessions will need to sign in again.",confirmLabel:"Sign out other devices",launcher:others,actionName:"other-device sign-out",needsPassword:false,onConfirm:async()=>{await securityApi.revokeOthers(options);return()=>load({message:"Other devices signed out."});}}),{unavailable});items.push(node("div",{className:"av2-security-footer"},[others]));}
    return section("Devices and sessions","sessions",items);
  }
  view.readiness=load();return view;
}
