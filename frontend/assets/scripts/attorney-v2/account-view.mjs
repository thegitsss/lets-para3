import { node, page, link, button } from "./dom.mjs";
import { accountPhoto } from "./account-api.mjs";
import { createSecurityView, isSecurityRoute } from "./security-view.mjs";
import { createBlockedView, isBlockedRoute } from "./blocked-view.mjs";
import { createClosureView, isClosureRoute } from "./closure-view.mjs";
import { accountNavigation } from "./account-navigation.mjs";

const clone = value => structuredClone(value);
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const LISTS = ["practiceAreas","publications","languages","experience"];
const prefKeys = ["inApp","inAppMessages","inAppCase","email","emailMessages","emailCase"];
const titles = { firstName:"First name", lastName:"Last name", email:"Email", phoneNumber:"Phone number", lawFirm:"Firm", firmWebsite:"Firm website", linkedInURL:"LinkedIn", state:"Bar state", barNumber:"Bar number", timezone:"Time zone", bio:"About your practice", practiceAreas:"Practice areas", publications:"Publications", languages:"Languages", experience:"Experience", yearsExperience:"Years of experience" };
const valueOf = (profile,key) => key === "yearsExperience" ? Number(profile[key]) || 0 : LISTS.includes(key) ? clone(Array.isArray(profile[key]) ? profile[key] : []) : String(profile[key] || "");
const displayed = (profile,key) => key === "bio" ? profile.bio || profile.about || "" : key === "practiceAreas" ? [...new Set([...valueOf(profile,key),...(profile.specialties||[])])] : valueOf(profile,key);
const dependency = {email:"pendingEmail",bio:"about",practiceAreas:"specialties"};
const dependencyValue = (profile,key) => key === "specialties" ? clone(profile.specialties||[]) : String(profile[key]||"");
const persisted = (profile,key,value) => key === "email" ? profile.email === value.trim().toLowerCase() || profile.pendingEmail === value.trim().toLowerCase() : equal(valueOf(profile,key),value);
const errorText = error => error.kind === "conflict" ? "This information changed in another session. Review the latest values before saving." : error.status === 400 ? "Check your entries and try again." : error.status === 403 ? "This change is unavailable to your account." : "The save could not be confirmed. Your changes are still here.";

function field(label, control, { wide = false, hint = "" } = {}) {
  return node("div", { className: `av2-account-field${wide ? " av2-account-wide" : ""}` }, [node("label", { for: control.id, text: label }), control, ...(hint ? [node("small", { text: hint })] : [])]);
}
function input(id, value, attrs = {}) { const element = node("input", { id, name: id, ...attrs }); element.value = String(value ?? ""); return element; }
function fieldset(title, children) { return node("fieldset", { className: "av2-account-section" }, [node("legend", { text: title }), node("div", { className: "av2-account-fields" }, children)]); }

export function createAccountView(route, identity, context = {}) {
  if (isClosureRoute(route)) return createClosureView(route, identity, context);
  if (isBlockedRoute(route)) return createBlockedView(route, identity, context);
  if (isSecurityRoute(route)) return createSecurityView(route, identity, context);
  const { accountApi, signal, privateState, onAccountConfirmed } = context;
  const view = page("Profile Settings"); view.classList.add("av2-account");
  const state = privateState.account, ownerId = identity.id, options = { ownerId, signal };
  if (state.ownerId !== ownerId) { Object.keys(state).forEach(key => delete state[key]); Object.assign(state,{ownerId,changes:{},expected:{},dirty:false}); }
  const requestedTarget=route.query.get("settingsTarget")||route.query.get("panel")||"";
  const targetAliases={"profile:personal":"firstName",attorneyPersonalHeading:"firstName","profile:public":"bio",attorneyProfessionalHeading:"bio","profile:firm":"lawFirm",attorneyFirmName:"lawFirm","profile:notifications":"inApp",attorneyNotificationsHeading:"inApp",notifications:"inApp",appearance:"theme","profile-photo":"photo"};
  const target=targetAliases[requestedTarget]||requestedTarget||(route.query.get("tab")==="notifications"?"inApp":route.query.get("tab")==="appearance"?"theme":"");
  const preferenceTarget=["theme","fontSize",...prefKeys].includes(target);
  const tab = ["preferences","notifications","appearance"].includes(route.query.get("tab"))||preferenceTarget ? "preferences" : "profile";
  const nav = accountNavigation(tab);
  const body = node("div", { "data-account-content": "", "aria-busy": "true" });
  const loadStatus = node("p", { className:"av2-muted",role:"status",text:"Loading account…" });
  const retry = button("Try again", () => { view.readiness=load(); }); retry.hidden=true;
  view.append(nav,loadStatus,retry,body);
  const dialogs = new Set();
  signal.addEventListener("abort", () => { dialogs.forEach(dialog=>dialog.close("interrupted")); dialogs.clear(); if(state.busy) {state.busy=false;state.uncertain=true;} }, {once:true});
  const active = () => !signal.aborted && state.ownerId===ownerId;
  async function readRecoveryProfile() {
    try { return await accountApi.readProfile(options); }
    catch { return null; } // Keep the existing failed/uncertain outcome unless readback confirms it.
  }
  const confirmed = profile => { if(active()) onAccountConfirmed?.({ id:ownerId, firstName:profile.firstName,lastName:profile.lastName,profileImage:profile.profileImage,avatarURL:profile.avatarURL,preferences:profile.preferences }); };
  function merge(profile) {
    for(const key of Object.keys(state.changes)) {
      if (persisted(profile,key,state.changes[key]) && (state.pending || state.uncertain)) { delete state.changes[key]; delete state.expected[key]; }
      else if(state.pending && Object.hasOwn(state.pending,key) && persisted(profile,key,state.pending[key]))state.expected[key]=valueOf(profile,key);
      if(dependency[key] && state.pending && Object.hasOwn(state.pending,key) && persisted(profile,key,state.pending[key]))state.expected[dependency[key]]=dependencyValue(profile,dependency[key]);
    }
    if(state.pending?.email && persisted(profile,"email",state.pending.email))state.expected.pendingEmail=profile.pendingEmail||"";
    if(!Object.hasOwn(state.changes,"email"))delete state.expected.pendingEmail;
    for(const key of ["bio","practiceAreas"])if(!Object.hasOwn(state.changes,key))delete state.expected[dependency[key]];
    state.profile=profile; state.dirty=Boolean(Object.keys(state.changes).length); state.uncertain=false;state.pending=null; confirmed(profile);
  }
  function setValue(key,value) {
    if (!Object.hasOwn(state.expected,key)) state.expected[key]=valueOf(state.profile,key);
    if (dependency[key] && !Object.hasOwn(state.expected,dependency[key])) state.expected[dependency[key]]=dependencyValue(state.profile,dependency[key]);
    if(equal(value,displayed(state.profile,key))) {delete state.changes[key];delete state.expected[key];} else state.changes[key]=clone(value);
    if (dependency[key] && !Object.hasOwn(state.changes,key)) delete state.expected[dependency[key]];
    state.dirty=Boolean(Object.keys(state.changes).length); updateSave?.();
  }
  const current = key => Object.hasOwn(state.changes,key) ? state.changes[key] : displayed(state.profile,key);
  function focusProfileField(key) {
    if(!active())return;
    const fieldKey=Object.hasOwn(titles,key)?key:"firstName";
    const control=body.querySelector(`#av2-account-${fieldKey}`)
      ||body.querySelector(`[data-account-collection="${fieldKey}"]`)?.querySelector("input,textarea,select,button")
      ||body.querySelector("#av2-account-firstName");
    control?.focus();
  }
  const checkAccount = button("Check saved account",()=>{view.readiness=load();},"av2-refresh"); checkAccount.hidden=true; view.firstChild.append(checkAccount);
  let updateSave;
  function dialog(title, launcher, fallback) {
    const element=node("dialog",{className:"av2-account-dialog","aria-labelledby":"av2-account-dialog-title"},[node("h2",{id:"av2-account-dialog-title",text:title})]);
    document.body.append(element);dialogs.add(element);
    element.addEventListener("close",()=>{dialogs.delete(element);element.remove();if(active()){if(launcher?.isConnected&&!launcher.disabled)launcher.focus();else fallback?.()?.focus();}},{once:true});
    return element;
  }
  async function load() {
    if(!active())return; body.setAttribute("aria-busy","true");retry.hidden=true;loadStatus.textContent="Loading account…";body.replaceChildren();
    try { const profile=await accountApi.readProfile(options); if(!active())return;const removalMessage=settlePhotoRemoval(profile);merge(profile);body.replaceChildren(tab==="preferences"?preferences():profileForm());loadStatus.textContent=removalMessage;
      if(tab==="profile"&&state.photoSelection){
        if(state.photoSelection.expectedPhotoRevision!==profile.profilePhotoRevision){delete state.photoSelection;loadStatus.textContent="Your saved photo changed. Review it before making another change.";}
        else void photoEditor(state.photoSelection.file,state.photoSelection.editExisting,body.querySelector(".av2-account-photo button"),state.photoSelection);
      }
      if(target&&!state.photoSelection)requestAnimationFrame(()=>{
        if(!active()||!view.isConnected)return;
        const control=target==="photo"?body.querySelector(".av2-account-photo button"):Object.hasOwn(titles,target)?body.querySelector(`#av2-account-${target}`):preferenceTarget?body.querySelector(`#av2-pref-${target}`):null;
        if(control&&(document.activeElement===document.body||document.activeElement?.matches("[data-av2-outlet]")||view.contains(document.activeElement)))control.focus();
      });
    }
    catch(error){if(!active()||error.name==="AbortError")return;loadStatus.textContent="Your account couldn’t load. Your unsaved changes are retained in this session.";retry.hidden=false;}
    finally{if(active())body.setAttribute("aria-busy","false");}
  }
  function textField(key, attrs={},hint="") {
    const id=`av2-account-${key}`, isArea=["bio","practiceAreas","publications"].includes(key);
    const control=isArea?node("textarea",{id,name:key,...attrs}):input(id,current(key),attrs);
    if(isArea)control.value=Array.isArray(current(key))?current(key).join("\n"):current(key);
    control.addEventListener("input",()=>{
      control.setCustomValidity("");
      if(key==="timezone"){try{if(!control.value.trim())throw new Error("Choose timezone");new Intl.DateTimeFormat("en-US",{timeZone:control.value.trim()});}catch{control.setCustomValidity("Enter a valid time zone, such as America/New_York.");}}
      if(["firstName","lastName"].includes(key)&&!control.value.trim())control.setCustomValidity("Enter your name.");
      const value=["practiceAreas","publications"].includes(key)?[...new Set(control.value.split("\n").map(v=>v.trim()).filter(Boolean))]:key==="yearsExperience"?Number(control.value):key==="timezone"?control.value.trim():control.value;
      if(Array.isArray(value)&&value.some(entry=>entry.length>200))control.setCustomValidity("Keep each entry to 200 characters or fewer.");
      setValue(key,value);
    });
    return field(titles[key],control,{wide:isArea,hint});
  }
  function timezoneField() {
    let zones;try{zones=Intl.supportedValuesOf("timeZone");}catch{zones=["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Anchorage","Pacific/Honolulu"];}
    const selected=String(current("timezone")||"");
    const choices=[...new Set(["UTC",...zones,...(selected?[selected]:[])])].map(value=>{const parts=value.split("/");const city=parts.pop().replaceAll("_"," ");return[value,value==="UTC"?"Coordinated Universal Time (UTC)":`${city}${parts.length?` — ${parts.join(" / ").replaceAll("_"," ")}`:""}`];}).sort((a,b)=>a[1].localeCompare(b[1]));
    const control=node("select",{id:"av2-account-timezone",name:"timezone"},[node("option",{value:"",text:"Not set",disabled:""}),...choices.map(([value,text])=>node("option",{value,text}))]);control.value=selected;control.addEventListener("change",()=>setValue("timezone",control.value));return field("Time zone",control);
  }
  function collection(key,columns) {
    const wrapper=node("div",{className:"av2-account-collection av2-account-wide","data-account-collection":key});
    function render() {
      const values=current(key);wrapper.replaceChildren();
      values.forEach((entry,index)=>{
        const value=typeof entry==="string"?{[columns[0][0]]:entry}:entry;
        const row=node("div",{className:"av2-account-entry"});
        columns.forEach(([name,title,max])=>{
          const id=`av2-${key}-${index}-${name}`,control=name==="description"?node("textarea",{id,maxlength:max}):input(id,value[name]||"",{maxlength:max,...(name===columns[0][0]?{required:""}:{})});
          if(name==="description")control.value=value[name]||"";
          control.addEventListener("input",()=>{const next=clone(current(key));next[index]={...(typeof next[index]==="object"?next[index]:value),[name]:control.value};setValue(key,next);});
          row.append(field(title,control));
        });
        row.append(node("div",{className:"av2-actions"},[button(`Remove ${key==="languages"?"language":"experience"}`,()=>{const next=clone(current(key));next.splice(index,1);setValue(key,next);render();wrapper.querySelector("button")?.focus();})]));wrapper.append(row);
      });
      const add=button(key==="languages"?"Add language":"Add experience",()=>{setValue(key,[...clone(current(key)),Object.fromEntries(columns.map(([name])=>[name,""]))]);render();wrapper.querySelectorAll(".av2-account-entry")[current(key).length-1]?.querySelector("input")?.focus();});
      wrapper.append(add);
    } wrapper.refresh=render;render();return wrapper;
  }
  function profileForm() {
    const form=node("form",{"data-account-profile-form":""});
    const feedback=node("p",{role:"status",className:"av2-account-feedback"});
    const editGrid=node("div",{className:"av2-account-grid"}),fields=node("div");
    fields.append(
      fieldset("Personal details",[textField("firstName",{required:"",maxlength:150,autocomplete:"given-name"}),textField("lastName",{required:"",maxlength:150,autocomplete:"family-name"}),textField("email",{required:"",type:"email",maxlength:320,autocomplete:"email"}),textField("phoneNumber",{type:"tel",maxlength:40,autocomplete:"tel"})]),
      fieldset("Professional details",[textField("lawFirm",{maxlength:300,autocomplete:"organization"}),textField("firmWebsite",{maxlength:2000,inputmode:"url"}),textField("linkedInURL",{maxlength:2000,inputmode:"url"}),textField("state",{maxlength:120}),textField("barNumber",{maxlength:100}),textField("yearsExperience",{type:"number",min:0,max:80,step:1}),timezoneField(),textField("bio",{maxlength:4000}),textField("practiceAreas",{},"One practice area per line.")]),
      fieldset("Experience",[collection("experience",[["title","Role or position",300],["years","Dates",120],["description","Description",5000]])]),
      fieldset("Languages",[collection("languages",[["name","Language",120],["proficiency","Proficiency",120]])]),
      node("div",{className:"av2-account-section av2-account-publications"},[textField("publications",{},"One publication per line.")])
    );
    const pending=state.profile.pendingEmail;
    if(pending)fields.firstChild.append(node("p",{className:"av2-muted",text:`Confirm ${pending} to change your email.`}));
    editGrid.append(photoControls(),fields);form.append(editGrid);
    const save=node("button",{type:"submit",className:"av2-button",text:"Save changes"});
    const cancel=button("Cancel changes",()=>{const firstChanged=Object.keys(state.changes)[0];state.changes={};state.expected={};state.dirty=false;state.uncertain=false;body.replaceChildren(profileForm());focusProfileField(firstChanged);});
    const review=button("Review latest values",()=>void reviewConflicts(review));review.hidden=true;
    updateSave=()=>{
      checkAccount.hidden=!state.uncertain && !state.photoRemoval;
      save.disabled=state.busy||!state.dirty;cancel.disabled=state.busy||!state.dirty;save.textContent=state.busy?"Saving…":"Save changes";
      // One persistent message reports the current save, including newer edits.
      if(state.busy)feedback.textContent="";
      else if(state.uncertain&&!feedback.textContent){feedback.dataset.state="error";feedback.textContent="The save could not be confirmed. Your changes are still here.";}
      else if(state.dirty&&(!feedback.textContent||["success","editing"].includes(feedback.dataset.state))){feedback.dataset.state="editing";feedback.textContent="Unsaved changes";}
      else if(!state.dirty&&feedback.dataset.state==="editing")feedback.textContent="";
    };
    form.append(node("div",{className:"av2-account-save"},[feedback,review,cancel,save]));updateSave();
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(state.busy||!state.dirty||!form.reportValidity())return;
      if(state.uncertain){
        state.busy=true;updateSave();
        try{const fresh=await accountApi.readProfile(options);if(!active())return;merge(fresh);}
        catch(error){if(active()){feedback.dataset.state="error";feedback.textContent="The last save is still unconfirmed. Check the saved account before trying again.";state.busy=false;updateSave();}return;}
        state.busy=false;if(!state.dirty){feedback.dataset.state="success";feedback.textContent="Changes saved.";updateSave();return;}
      }
      const changes=clone(state.changes),expected=Object.fromEntries(Object.keys(changes).map(key=>[key,clone(state.expected[key])]));
      if(Object.hasOwn(changes,"email"))expected.pendingEmail=state.expected.pendingEmail || "";
      for(const key of ["bio","practiceAreas"])if(Object.hasOwn(changes,key))expected[dependency[key]]=clone(state.expected[dependency[key]]);
      state.busy=true;state.pending=changes;updateSave();feedback.textContent="";review.hidden=true;
      try{
        const result=await accountApi.saveProfile(changes,expected,options);if(!active())return;
        for(const key of Object.keys(changes)){if(equal(state.changes[key],changes[key])){delete state.changes[key];delete state.expected[key];}else if(Object.hasOwn(state.changes,key)){state.expected[key]=valueOf(result,key);}}
        if(Object.hasOwn(changes,"email")){if(Object.hasOwn(state.changes,"email"))state.expected.pendingEmail=result.pendingEmail||"";else delete state.expected.pendingEmail;}
        for(const key of ["bio","practiceAreas"])if(Object.hasOwn(changes,key)){if(Object.hasOwn(state.changes,key))state.expected[dependency[key]]=dependencyValue(result,dependency[key]);else delete state.expected[dependency[key]];}
        state.profile=result;state.pending=null;state.uncertain=false;state.dirty=Boolean(Object.keys(state.changes).length);confirmed(result);
        for(const key of Object.keys(changes))if(!Object.hasOwn(state.changes,key)){
          const control=form.querySelector(`#av2-account-${key}`);
          if(control&&key!=="email"){const value=displayed(result,key);control.value=Array.isArray(value)?value.join("\n"):value;}
          if(!equal(changes[key],valueOf(result,key)))form.querySelector(`[data-account-collection="${key}"]`)?.refresh();
        }
        feedback.dataset.state="success";feedback.textContent=changes.email&&result.pendingEmail?"Changes saved. Verify your new email to finish changing it.":"Changes saved.";
      }catch(error){if(!active())return;state.uncertain=["network","invalid_response"].includes(error.kind)||error.status>=500||error.name==="AbortError";feedback.dataset.state="error";feedback.textContent=errorText(error);review.hidden=error.kind!=="conflict";
        if(state.uncertain){const fresh=await readRecoveryProfile();if(!active())return;if(fresh&&Object.entries(changes).every(([key,value])=>persisted(fresh,key,value))){merge(fresh);feedback.dataset.state="success";feedback.textContent="Changes saved.";}else if(fresh){state.profile=fresh;}}
      }
      finally{if(active()){state.busy=false;updateSave();}}
    });
    return form;
  }
  async function reviewConflicts(launcher) {
    launcher.disabled=true;
    try{
      const latest=await accountApi.readProfile(options);if(!active())return;
      const changed=Object.keys(state.changes).filter(key=>!equal(state.expected[key],valueOf(latest,key)) || dependency[key] && !equal(state.expected[dependency[key]],dependencyValue(latest,dependency[key])));
      if(!changed.length){state.profile=latest;body.replaceChildren(profileForm());focusProfileField(Object.keys(state.changes)[0]);return;}
      const modal=dialog("Review profile changes",launcher);
      modal.append(node("p",{className:"av2-muted",text:"Choose which values to keep. Your other edits are retained."}));
      changed.forEach(key=>{
        const show=value=>typeof value==="object"?JSON.stringify(value,null,2):String(value||"—");
        const item=node("section",{className:"av2-account-section"},[node("h3",{text:titles[key]||key}),node("p",{text:`Latest: ${show(key==="email"&&latest.pendingEmail?`${latest.email} (pending: ${latest.pendingEmail})`:displayed(latest,key))}`}),node("p",{text:`Your edit: ${show(state.changes[key])}`})]);
        const select=node("select",{id:`av2-conflict-${key}`,"aria-label":`Value to keep for ${titles[key]}`},[node("option",{value:"latest",text:"Keep latest value"}),node("option",{value:"mine",text:"Keep my edit"})]);item.append(select);modal.append(item);
      });
      const apply=button("Apply choices",()=>{changed.forEach(key=>{if(modal.querySelector(`#av2-conflict-${key}`).value==="latest"){delete state.changes[key];delete state.expected[key];}else state.expected[key]=valueOf(latest,key);if(dependency[key]){if(Object.hasOwn(state.changes,key))state.expected[dependency[key]]=dependencyValue(latest,dependency[key]);else delete state.expected[dependency[key]];}});state.profile=latest;state.dirty=Boolean(Object.keys(state.changes).length);modal.close();body.replaceChildren(profileForm());focusProfileField(changed[0]);},"av2-button");
      modal.append(node("div",{className:"av2-actions"},[button("Cancel",()=>modal.close()),apply]));modal.showModal();
    }catch(error){if(active()){loadStatus.textContent="The latest values couldn’t load. Your edits are retained.";}}
    finally{if(active())launcher.disabled=false;}
  }
  function settlePhotoRemoval(profile) {
    const pending=state.photoRemoval;if(!pending)return "";
    delete state.photoRemoval;
    return !accountPhoto(profile.profileImage||profile.avatarURL,ownerId)?"Your profile photo is no longer saved.":profile.profilePhotoRevision!==pending.expectedPhotoRevision?"Your saved photo changed. Review it before making another change.":"Your photo is still saved. Review it before trying again.";
  }
  async function reviewPhotoRemoval() {
    if(!active()||!state.photoRemoval||state.busy)return;
    state.busy=true;updateSave?.();body.querySelectorAll('.av2-account-photo button').forEach(control=>{control.disabled=true;});
    try {
      const profile=await accountApi.readProfile(options);if(!active())return;
      const message=settlePhotoRemoval(profile);merge(profile);loadStatus.textContent=message;
    } catch(error) {
      if(active()&&error.name!=="AbortError")loadStatus.textContent="The photo removal result could not be confirmed. Check the saved photo before making another change.";
    } finally {
      if(active()){state.busy=false;updateSave?.();body.querySelector('.av2-account-photo')?.replaceWith(photoControls());body.querySelector('.av2-account-photo button:not(:disabled)')?.focus();}
    }
  }
  function photoControls() {
    const container=node("aside",{className:"av2-account-photo","aria-label":"Profile photo"});
    const picture=node("div",{className:"av2-account-photo-image"});
    const photo=accountPhoto(state.profile.profileImage||state.profile.avatarURL,ownerId);
    const initials=node("span",{text:[state.profile.firstName,state.profile.lastName].map(v=>v.slice(0,1)).join("").toUpperCase(),"aria-hidden":"true"});picture.append(initials);
    if(photo){const image=node("img",{src:photo,alt:"Your profile photo"});image.addEventListener("load",()=>{initials.hidden=true;});image.addEventListener("error",()=>{image.remove();initials.hidden=false;});picture.append(image);}
    const status=node("p",{role:"status",className:"av2-account-feedback"});
    const file=input("av2-account-photo-file","",{type:"file",accept:"image/jpeg,image/png",hidden:"","aria-label":"Choose profile photo"});
    const choose=button(photo?"Change photo":"Add photo",()=>{if(!state.busy&&!state.photoRemoval)file.click();});
    const edit=button("Edit crop",async()=>{if(state.busy)return;edit.disabled=true;status.textContent="Loading original…";try{const blob=await accountApi.readOriginal({...options,expectedPhotoRevision:state.profile.profilePhotoRevision});if(active())await photoEditor(new File([blob],blob.type==="image/png"?"original.png":"original.jpg",{type:blob.type}),true,edit);}catch(error){if(active())status.textContent=error.kind==="conflict"?"Your photo changed in another session. Refresh before editing it.":"The original photo couldn’t load. Try again or choose a new photo.";}finally{if(active()){edit.disabled=false;if(status.textContent==="Loading original…")status.textContent="";}}});
    const remove=button("Remove photo",()=>{
      if(state.busy||state.photoRemoval)return;const expectedPhotoRevision=state.profile.profilePhotoRevision;
      const modal=dialog("Remove profile photo?",remove,()=>body.querySelector('.av2-account-photo button:not(:disabled)'));modal.append(node("p",{text:"This removes your profile photo throughout LPC."}));
      const feedback=node("p",{role:"status",className:"av2-account-feedback"});
      const cancel=button("Cancel",()=>modal.close());
      const confirm=button("Remove photo",async()=>{
        confirm.disabled=true;cancel.disabled=true;confirm.textContent="Removing…";state.busy=true;state.photoRemoval={expectedPhotoRevision};updateSave?.();
        let needsReadback=false;
        try {
          const result=await accountApi.saveProfile({avatarURL:"",expectedPhotoRevision},{},options);if(!active())return;
          delete state.photoRemoval;state.profile=result;confirmed(result);modal.close();container.replaceWith(photoControls());
        } catch(error) {
          if(active()&&error.name!=="AbortError"){needsReadback=true;modal.close("unconfirmed");}
        } finally {if(active()){state.busy=false;updateSave?.();}}
        if(needsReadback)await reviewPhotoRemoval();
      },"av2-button");
      modal.addEventListener("cancel",event=>{if(confirm.disabled)event.preventDefault();});
      modal.append(feedback,node("div",{className:"av2-actions"},[cancel,confirm]));modal.showModal();
    });
    file.addEventListener("change",()=>{const selected=file.files?.[0];file.value="";if(selected)void photoEditor(selected,false,choose);});
    choose.disabled=edit.disabled=remove.disabled=Boolean(state.photoRemoval);
    const check=state.photoRemoval?button("Check photo",()=>{view.readiness=reviewPhotoRemoval();},"av2-secondary"):null;
    const controls=node("div",{className:"av2-account-photo-controls"},[
      node("div",{className:"av2-account-photo-actions"},[choose,...(photo?[edit,remove]:[]),...(check?[check]:[])]),
      node("p",{className:"av2-muted",text:"JPEG or PNG, up to 5 MB."}),status,
    ]);
    container.append(picture,controls,link("View public profile","#/profile"),file);return container;
  }
  async function photoEditor(file,editExisting,launcher,retained=null) {
    if(!/^image\/(jpeg|png)$/.test(file.type)||!file.size||file.size>5*1024*1024){loadStatus.textContent="Choose a JPEG or PNG image no larger than 5 MB.";return;}
    const selection=retained||{file,editExisting,expectedPhotoRevision:state.profile.profilePhotoRevision,zoom:1,x:0,y:0};state.photoSelection=selection;
    const url=URL.createObjectURL(file),image=new Image();image.alt="Photo crop preview";image.draggable=false;
    try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});}catch{URL.revokeObjectURL(url);if(state.photoSelection===selection)delete state.photoSelection;if(active())loadStatus.textContent="The selected photo couldn’t open.";return;}
    if(!active()){URL.revokeObjectURL(url);return;}
    const expectedPhotoRevision=selection.expectedPhotoRevision;
    const modal=dialog("Edit profile photo",launcher);modal.append(node("p",{className:"av2-muted",text:"Drag or use arrow keys to adjust the crop. Saving updates your profile photo and submits it for review."}));
    const viewport=node("div",{className:"av2-account-crop",tabindex:"0","aria-label":"Photo position. Use arrow keys to move."},[image]);
    const zoom=input("av2-account-photo-zoom",selection.zoom,{type:"range",min:1,max:3,step:.01});
    const feedback=node("p",{role:"status",className:"av2-account-feedback"});
    let x=selection.x,y=selection.y,drag=null,busy=false;
    const dimensions=()=>{const size=viewport.clientWidth||300,scale=Math.max(size/image.naturalWidth,size/image.naturalHeight)*Number(zoom.value);return{size,width:image.naturalWidth*scale,height:image.naturalHeight*scale};};
    function render(){const{size,width,height}=dimensions();x=Math.max((size-width)/2,Math.min((width-size)/2,x));y=Math.max((size-height)/2,Math.min((height-size)/2,y));Object.assign(selection,{x,y,zoom:Number(zoom.value)});image.style.width=`${width}px`;image.style.height=`${height}px`;image.style.transform=`translate(calc(-50% + ${x}px),calc(-50% + ${y}px))`;}
    zoom.addEventListener("input",render);viewport.addEventListener("pointerdown",e=>{if(busy)return;drag={x:e.clientX,y:e.clientY};viewport.setPointerCapture(e.pointerId);});
    viewport.addEventListener("pointermove",e=>{if(!drag)return;x+=e.clientX-drag.x;y+=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};render();});
    for(const event of ["pointerup","pointercancel"])viewport.addEventListener(event,()=>{drag=null;});
    viewport.addEventListener("keydown",event=>{if(busy)return;const delta={ArrowLeft:[-5,0],ArrowRight:[5,0],ArrowUp:[0,-5],ArrowDown:[0,5]}[event.key];if(delta){event.preventDefault();x+=delta[0];y+=delta[1];render();}});
    const save=button("Save photo",async()=>{
      if(busy)return;busy=true;state.busy=true;save.disabled=true;cancel.disabled=true;zoom.disabled=true;save.textContent="Saving…";feedback.textContent="";updateSave?.();
      try{const canvas=document.createElement("canvas");canvas.width=600;canvas.height=600;const ctx=canvas.getContext("2d",{alpha:false});ctx.fillStyle="#fff";ctx.fillRect(0,0,600,600);const{size,width,height}=dimensions(),ratio=600/size;ctx.drawImage(image,(600-width*ratio)/2+x*ratio,(600-height*ratio)/2+y*ratio,width*ratio,height*ratio);const blob=await new Promise(resolve=>canvas.toBlob(resolve,file.type,.92));if(!blob)throw new Error("Photo preparation failed");const payload=new FormData();payload.append("file",blob,file.type==="image/png"?"profile.png":"profile.jpg");payload.append("original",file,file.name);if(editExisting)payload.append("editExisting","1");
        payload.append("expectedPhotoRevision",expectedPhotoRevision);
        await accountApi.uploadPhoto(payload,options);if(!active())return;
        // The upload response confirms storage. A separate refresh failure must
        // never invite a second upload of an already-saved photo.
        save.textContent="Photo saved";if(state.photoSelection===selection)delete state.photoSelection;
        try{const profile=await accountApi.readProfile(options);if(!active())return;state.profile=profile;confirmed(profile);modal.close();body.querySelector(".av2-account-photo")?.replaceWith(photoControls());}catch(error){if(active()){feedback.textContent="Photo saved. Close this window and refresh to view it.";save.hidden=true;cancel.disabled=false;cancel.textContent="Close";busy=false;}}
      }catch(error){if(active()){
        feedback.dataset.state="error";feedback.textContent=errorText(error);save.disabled=false;cancel.disabled=false;save.textContent="Save photo";zoom.disabled=false;busy=false;
        const fresh=await readRecoveryProfile();if(active()&&fresh&&fresh.profilePhotoRevision!==expectedPhotoRevision){state.profile=fresh;confirmed(fresh);body.querySelector(".av2-account-photo")?.replaceWith(photoControls());feedback.textContent="Your saved photo changed. Close this window to review it before making another change.";save.hidden=true;cancel.textContent="Close";}
      }}
      finally{if(active()){state.busy=false;updateSave?.();}}
    },"av2-button");
    const cancel=button("Cancel",()=>modal.close());modal.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
    modal.append(viewport,field("Zoom",zoom),feedback,node("div",{className:"av2-actions"},[cancel,save]));
    const resize=new ResizeObserver(render);resize.observe(viewport);
    modal.addEventListener("close",()=>{resize.disconnect();URL.revokeObjectURL(url);if(modal.returnValue!=="interrupted"&&state.photoSelection===selection)delete state.photoSelection;},{once:true});modal.showModal();requestAnimationFrame(render);
  }
  function preferences() {
    const content=node("div",{"data-account-preferences":""});
    state.preferenceRequests ||= {};
    const preferences=state.profile.preferences||{},notificationPrefs=state.profile.notificationPrefs||{};
    const appearance=node("section",{className:"av2-account-section"},[node("h2",{text:"Appearance"})]);
    function mutationRow(label,key,value,choices) {
      const toggle=!choices;
      const control=toggle?input(`av2-pref-${key}`,"",{type:"checkbox"}):node("select",{id:`av2-pref-${key}`},choices.map(([id,text])=>node("option",{value:id,text})));
      const setControl=value=>{if(toggle)control.checked=value;else control.value=value;};
      let saved=value,request=state.preferenceRequests[key];
      if(request && equal(request.requested,saved)){delete state.preferenceRequests[key];request=null;}
      setControl(saved);
      const feedback=node("p",{role:"status",className:"av2-account-feedback"});
      const retry=button("Try again",()=>void save());retry.hidden=!request;
      const row=node("div",{className:"av2-account-preference"},[toggle?node("label",{className:"av2-account-toggle",for:control.id},[control,node("span",{text:label})]):field(label,control),feedback,retry]);
      if(request){request.busy=false;feedback.dataset.state="error";feedback.textContent="Your earlier change is not confirmed. Try again to apply your selection.";}
      function success(value){saved=value;setControl(saved);delete state.preferenceRequests[key];if(toggle)state.profile.notificationPrefs={...state.profile.notificationPrefs,[key]:saved};else{state.profile.preferences={...state.profile.preferences,[key]:saved};confirmed(state.profile);}content.querySelectorAll('.av2-account-feedback[data-state="success"]').forEach(previous=>{previous.textContent="";});feedback.dataset.state="success";feedback.textContent="Saved.";retry.hidden=true;}
      async function verifyRequest(){const fresh=await accountApi.readProfile(options);if(!active())return false;const current=toggle?fresh.notificationPrefs?.[key]!==false:fresh.preferences?.[key];if(toggle)state.profile.notificationPrefs=fresh.notificationPrefs;else state.profile.preferences=fresh.preferences;saved=current;setControl(saved);if(equal(saved,request.requested)){success(saved);return true;}return false;}
      async function save(){
        request=state.preferenceRequests[key];if(!request||request.busy||!active())return;
        request.busy=true;state.busy=true;control.disabled=true;retry.hidden=true;feedback.textContent="Saving…";
        try{
          if(request.uncertain && await verifyRequest())return;
          const result=toggle?await accountApi.saveNotificationPreferences({[key]:request.requested},{[key]:saved},options):await accountApi.savePreferences({[key]:request.requested},{[key]:saved},options);
          if(!active())return;const values=toggle?result.notificationPrefs:result.preferences;
          if(!values||values[key]!==request.requested||!toggle&&!result.success)throw new Error("Unconfirmed preference");
          success(request.requested);
        }catch(error){
          if(!active())return;request.uncertain=true;
          try{if(await verifyRequest())return;}catch{request.uncertain=true; /* An explicit retry must recheck before sending again. */}
          if(!active())return;setControl(saved);feedback.dataset.state="error";
          feedback.textContent=error.kind==="conflict"?"This setting changed in another session. The latest value is shown.":errorText(error);
          retry.textContent=error.kind==="conflict"?"Apply my selection":"Try again";retry.hidden=false;
        }finally{if(active()){request.busy=false;state.busy=Object.values(state.preferenceRequests).some(item=>item.busy);control.disabled=false;}}
      }
      control.addEventListener("change",()=>{state.preferenceRequests[key]={requested:toggle?control.checked:control.value,busy:false,uncertain:false};void save();});
      return row;
    }
    const theme=preferences.theme||"light";
    const themes=[["light","Light"],["dark","Dark"]];if(["mountain","mountain-dark"].includes(theme))themes.unshift([theme,/dark$/.test(theme)?"Mountain dark (saved)":"Mountain (saved)"]);
    appearance.append(mutationRow("Theme","theme",theme,themes),mutationRow("Text size","fontSize",preferences.fontSize||"md",[["xs","Extra small"],["sm","Small"],["md","Default"],["lg","Large"],["xl","Extra large"]]));
    const alerts=node("section",{className:"av2-account-section"},[node("h2",{text:"Notifications"})]);
    const labels={inApp:"In-app notifications",inAppMessages:"In-app messages",inAppCase:"In-app Matter updates",email:"Email notifications",emailMessages:"Email messages",emailCase:"Email Matter updates"};
    prefKeys.forEach(key=>alerts.append(mutationRow(labels[key],key,notificationPrefs[key]!==false)));
    alerts.append(node("p",{className:"av2-muted",text:"Security and account notices may still be sent when other emails are turned off."}));content.append(appearance,alerts);return content;
  }
  view.readiness=load();return view;
}
