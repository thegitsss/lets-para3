import {canvasValue} from './canvas-value.mjs';
import {createCanvasLayout} from './canvas-layout.mjs';
import { createDraftSurface } from './draft-surface.mjs';
import { createDraftComposer } from './draft-composer.mjs';
import { node, page, link, button } from "./dom.mjs";
import { matterReturnHref, withMatterReturn } from "./matter-return.mjs";
import { matterLink } from "./workspace-model.mjs";
import { draftValues as normalDraftValues, draftErrors as normalDraftErrors, dollarCents, draftLabels, validDraftId, validRequestId, validDraftDate } from "../matter-draft-contract.mjs";
import { createDraftSession, newDraftState } from "../matter-draft-session.mjs";
import { createDraftRecovery } from "../matter-draft-recovery.mjs";
import { createPublication } from "../matter-publication.mjs";
import { draftPractices, draftStates, draftExperience } from "./draft-options.mjs";
import "../utils/business-date.js";
import { retainedDraftApi } from "./retained-draft-api.mjs";

const currency = (cents) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
export function createDraftEditor(route, identity, { api, signal, privateState, navigation, creationHost }) {
  const retained = route.query.has("caseDraftId");
  const descriptionLimit = retained ? 100000 : 4000;
  const draftValues = value => normalDraftValues(value, { descriptionLimit });
  const draftErrors = (value, options = {}) => normalDraftErrors(value, { ...options, descriptionLimit });
  const section = page(retained ? "Continue Matter draft" : "Create a Matter");
  section.classList.add("lpc-draft-editor");
  const headingId=creationHost?"av2-creation-editor-title":"av2-page-title";
  section.querySelector("h1").id=headingId;
  const routeHref = href => navigation?.href ? navigation.href(href) : href;
  const returnHref = navigation?.returnHref || matterReturnHref(route, "#/matters?view=draft");
  const returnLabel = navigation?.returnLabel || (new URLSearchParams(returnHref.split("?")[1]).get("view") === "draft" ? "drafts" : "Matters");
  const id = route.query.get(retained ? "caseDraftId" : "draftId") || "";
  const requested = route.query.get("request");
  if (((retained || route.query.has("draftId")) && !validDraftId(id)) || (retained && route.query.has("draftId")) || (requested !== null && !validRequestId(requested))) {
    section.append(node("p", { role: "alert", text: "This draft link is invalid. Open a draft from Matters to continue." }), link(`Return to ${returnLabel}`, returnHref)); return section;
  }
  const requestId = requested || crypto.randomUUID();
  const stateKey = value => retained ? `case:${value}` : value;
  const state = privateState.drafts.get(stateKey(id || requestId)) || newDraftState({ id, requestId, descriptionLimit });
  privateState.drafts.set(stateKey(id || requestId), state);
  if (retained) api = retainedDraftApi(api, state);
  let step = ["details", "description", "review"].includes(route.query.get("step")) ? route.query.get("step") : "details";
  if (!navigation) step = route.query.get("step") === "describe" || (!id && !route.query.has("step")) ? "describe" : step === "review" ? "review" : "description";
  let errors = {};
  let canvasLayout;
  let surface, saveStatus, stepHeading, saveReview, recoveringSave=false;
  function syncIdentity() {
    if (signal.aborted) return;
    if (state.id) { route.query.set(retained ? "caseDraftId" : "draftId", state.id); route.query.delete("request"); privateState.drafts.set(stateKey(state.id), state); }
    else route.query.set("request", state.requestId);
    route.query.set("step", step);
    if (creationHost) creationHost.sync?.(route.query, step);
    else if (navigation?.sync) navigation.sync(route.query, step);
    else history.replaceState(history.state, "", `#/matters/new?${route.query}`);
  }
  syncIdentity();
  let recovery, publication, assistant;
  const suggestionApi = api;
  const session = createDraftSession(state, { api, ownerId: identity.id, signal, onIdentity: syncIdentity, onChange: render });
  recovery = createDraftRecovery({
    ...session,
    async save() { const saved = await session.save(); if (saved) await resumeReview(); return saved; },
    async check() {
      // Another tab may have published this original Case while this editor
      // was open. Resolve its durable receipt before treating it as a draft.
      const retrySave=Boolean(creationHost&&state.action==='save'&&state.uncertain&&!state.conflict&&!state.missing&&!state.restricted);
      if(retained)await publication.check();
      if (!publication.result) {
        const checked=await session.check();
        if(retrySave&&checked&&!state.conflict&&!state.missing&&!state.restricted)await session.save();
        if(checked)await resumeReview();
      }
    },
  });
  const nav = node("nav", { className: "av2-actions av2-draft-steps", "aria-label": "Matter draft steps" });
  const panels = {}, controls = {}, errorNodes = {}, stepButtons = {};
  for (const [name, title] of [["details", "1. Matter details"], ["description", "2. Description and tasks"], ["review", "3. Review"]]) {
    stepButtons[name] = button(title, () => changeStep(name)); nav.append(stepButtons[name]);
    panels[name] = node("fieldset", { className: "av2-card av2-draft-fields", "data-draft-step": name, tabindex: -1 }, [node("legend", { className: "lpc-draft-visually-hidden", text: title })]);
  }
  function field(key, type, choices) {
    const control = node(choices ? "select" : type === "textarea" ? "textarea" : "input", { id: `av2-draft-${key}`, name: key, ...(choices || type === "textarea" ? {} : { type }), autocomplete: "off" });
    if (choices) choices.forEach(([value, text]) => control.append(node("option", { value, text })));
    else control.maxLength = key === "description" ? descriptionLimit : key === "title" ? 300 : key === "compAmount" ? 100 : key === "deadline" ? 50 : 200;
    if (key === "compAmount") control.inputMode = "decimal";
    if (key === "description") control.rows = 8;
    controls[key] = control;
    const error = node("p", { id: `av2-draft-${key}-error`, className: "av2-draft-error" }); errorNodes[key] = error;
    control.setAttribute("aria-describedby", error.id);
    const optional = ["experience", "deadline"].includes(key);
    const label = `${draftLabels[key]}${optional ? " (optional)" : ""}`;
    if (!optional) control.setAttribute("aria-required", "true");
    control.addEventListener("input", collect);
    return node("div", { className: `av2-field av2-draft-field-${key}` }, [node("label", { for: control.id, text: label }), control, error]);
  }
  const compensation = field("compAmount", "text");
  controls.compAmount.addEventListener('blur',()=>{
    const message=state.values.compAmount?draftErrors(state.values).compAmount:'';
    if(message)errors.compAmount=message;else delete errors.compAmount;
    render();
  });
  panels.details.append(field("title", "text"), field("practiceArea", null, draftPractices), field("state", null, draftStates), field("experience", null, draftExperience), field("deadline", "date"), compensation, node('div', {className:'av2-actions av2-draft-step-actions'}, [button("Continue", () => changeStep("description"), "av2-button")]));
  const tasks = node("div", { className: "av2-draft-tasks" });
  const manualEntry=()=>Boolean(creationHost&&step!=='describe'&&!state.values.sourceDescription?.trim()&&!state.values.appliedSourceDescription?.trim());
  function renderTasks() {
    tasks.replaceChildren();
    const rows=manualEntry()&&!state.values.tasks.length?[{title:''}]:state.values.tasks;
    rows.forEach((task, index) => {
      const control = node("input", { type: "text", value: task.title, placeholder:manualEntry()&&index===0?'For example, a tabbed trial binder':'', maxlength: 200, "aria-label": `Task ${index + 1}`, autocomplete: "off" });
      control.addEventListener("input", () => { const values = structuredClone(state.values); values.tasks[index] = {title:control.value}; state.creationEditedFields=[...new Set([...(state.creationEditedFields||[]),'tasks'])];session.edit(values); });
      tasks.append(node("div", { className: "av2-draft-task" }, [control, ...(rows.length > 1 ? [button(`Remove task ${index + 1}`, () => { const values = structuredClone(state.values); values.tasks.splice(index, 1);state.creationEditedFields=[...new Set([...(state.creationEditedFields||[]),'tasks'])]; session.edit(values); renderTasks(); })] : [])]));
    });
    if(creationHost)tasks.querySelectorAll("input").forEach((control,index)=>{const editor=canvasValue(control,{persistent:manualEntry,label:`task ${index+1}`,placeholder:"Add task"});control.canvasEditor=editor;});
    if(!navigation)tasks.querySelectorAll('.av2-draft-task > button:last-child').forEach((button,index)=>{button.setAttribute('aria-label', `Remove task ${index+1}`);button.textContent='×';});
  }
  const taskError = node("p", { className: "av2-draft-error" });
  panels.description.append(field("description", "textarea"), node("div", {className:"av2-draft-task-heading"}, [node("h2", { text: "Tasks" })]), tasks, taskError, button("Add task", () => { const values = structuredClone(state.values); values.tasks.push({ title: "" });state.creationEditedFields=[...new Set([...(state.creationEditedFields||[]),'tasks'])]; session.edit(values); renderTasks(); const control=tasks.querySelector(".av2-draft-task:last-child input");if(control?.canvasEditor)control.canvasEditor.open();else control?.focus(); }), node("div", { className: "av2-actions av2-draft-step-actions" }, [button("Back to details", () => changeStep("details")), button("Review draft", () => changeStep("review"), "av2-button")]));
  const review = node("div", { className: "av2-draft-review" });
  const publish = button("Review publishing confirmation", async () => {
    errors = draftErrors(state.values); render();
    if (!Object.keys(errors).length) await prepareReview();
  }, "av2-button");
  panels.review.append(review, node("div", {className:"av2-actions av2-draft-step-actions"}, [button("Back to description", () => changeStep("description")), publish]));
  const validation = node("p", { role: "alert", className: "av2-draft-error" });
  const confirmation = node("div", { className: "av2-card", role: "group", "aria-label": "Delete draft confirmation", tabindex: -1, hidden: "" }, [node("h2", { text: "Delete this draft?" }), node("p", { text: "This removes the saved draft and discards any unsaved edits in this editor." })]);
  const confirmDelete = button("Delete draft permanently", async () => {
    const restoreFocus = confirmation.contains(document.activeElement);
    await session.remove(); confirmation.hidden = true; render();
    if (state.deleted && restoreFocus && deleted.isConnected && (document.activeElement === document.body || section.contains(document.activeElement))) deleted.focus({ preventScroll: true });
  });
  confirmation.append(confirmDelete, button("Keep draft", () => { confirmation.hidden = true; menuToggle.focus(); }));
  const remove = button("Delete draft", () => { footer.open = false; confirmation.hidden = false; confirmDelete.focus(); });
  const exit = button("Save and exit", async () => { if (await session.save() && !state.dirty && !signal.aborted) { if (navigation?.go) navigation.go(returnHref); else location.hash = returnHref; } });
  const returnLink = link(`Return to ${returnLabel}`, returnHref);
  const menuToggle = node('summary', {text:'⋯', 'aria-label':'Draft actions', title:'Draft actions'});
  const footer = node('details', {className:'av2-draft-overflow'}, [menuToggle, node('div', {className:'av2-draft-overflow-options'}, [exit, remove, returnLink])]);
  footer.addEventListener('keydown', event => { if(event.key === 'Escape') { event.preventDefault(); footer.open=false; menuToggle.focus(); } });
  document.addEventListener('pointerdown', event => { if(!footer.contains(event.target)) footer.open=false; }, {signal});
  document.addEventListener('focusin', event => { if(!footer.contains(event.target)) footer.open=false; }, {signal});
  section.querySelector('.av2-view-header').append(footer);
  const deleted = node("section", { className: "av2-card lpc-matter-outcome", "aria-label": "Draft deletion status", tabindex: -1, hidden: "" }, [node("header", {}, [node("h1", { id: "matter-draft-deleted-title", text: "Draft deleted" })]), node("div", { className: "av2-actions" }, [link(`Return to ${returnLabel}`, returnHref, "av2-secondary"), link("Create another Matter", routeHref(withMatterReturn("#/matters/new", route)), "av2-secondary")])]);
  publication = createPublication({ state, session, api, ownerId: identity.id, signal, onChange: render, matterHref: id => routeHref(withMatterReturn(matterLink(id), route)), returnHref, reviewControl: publish, onPublished: creationHost?.published, integratedReview:Boolean(creationHost), onCancel:creationHost?()=>changeStep("description"):null,
    confirmationDetails: !navigation ? () => {
      const cents=dollarCents(state.values.compAmount);if(cents===null)return null;
      const fee=Math.round(cents*.22);
      return node('div',{className:'av2-compose-disclosure','aria-label':'Attorney payment breakdown'},[
        node('span',{text:`Matter compensation ${currency(cents)}`}),
        node('span',{text:`LPC platform fee (22%) ${currency(fee)}`}),
        node('strong',{text:`Total when you hire ${currency(cents+fee)}`}),
        node('p',{text:'Publishing does not charge you. You’ll fund the Matter when you hire a paralegal.'})
      ]);
    } : null });
  const restrictedActions = [link("Contact support", routeHref("#/help"), "av2-secondary"), link(`Return to ${returnLabel}`, returnHref, "av2-secondary")];
  recovery.root.querySelector(".av2-actions").append(...restrictedActions);
  section.append(publication.root, node("div", {className:"av2-draft-toolbar"}, [nav, recovery.root]), validation, ...Object.values(panels), confirmation, deleted);
  function collect() {
    const values = { ...state.values };
    for (const [key, control] of Object.entries(controls)) {
      if(creationHost&&control.value!==state.values[key])
        state.creationEditedFields=[...new Set([...(state.creationEditedFields||[]),key])];
      values[key] = control.value;
    }
    session.edit(values);
    if (Object.keys(errors).length) {
      if(!navigation&&step!=='review'&&Object.keys(errors).every(key=>key==='compAmount')){
        const message=state.values.compAmount?draftErrors(state.values).compAmount:'';
        errors=message?{compAmount:message}:{};
      }else errors=draftErrors(state.values,{description:step==='review'});
      render();
    }
  }
  async function prepareReview() {
    await publication.prepare();
    if (signal.aborted || !creationHost || step !== 'review' || !publication.visible) return;
    const target = section.querySelector('.av2-confirmation-preview > h2') || publication.root;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
  async function resumeReview() {
    if (creationHost && step === 'review' && !publication.visible && !state.dirty && !state.uncertain && !state.conflict && !state.restricted && !state.missing && !Object.keys(draftErrors(state.values)).length) await prepareReview();
  }
  function changeStep(next) {
    if(creationHost&&next!=="review"&&publication?.visible&&state.publication?.phase==="ready")publication.cancel();
    if(creationHost&&next==='review'&&surface&&!surface.prepareReview())return;
    if (!navigation && next === "details") next = "description";
    errors = next === "review" ? draftErrors(state.values) : !navigation || next === "details" ? {} : draftErrors(state.values, { description: false });
    if (Object.keys(errors).length) { step = !navigation ? "description" : Object.keys(errors).some((key) => !["description", "tasks"].includes(key)) ? "details" : "description"; render(); const key=Object.keys(errors)[0]; if(creationHost&&controls[key])surface.focus(key);else {const control=controls[key] || tasks.querySelector("input");if(control?.canvasEditor)control.canvasEditor.open();else control?.focus();} return; }
    if(creationHost&&next==='describe'&&assistant&&!state.values.sourceDescription?.trim()){assistant.brief.value=state.values.description||'';state.creationBrief=assistant.brief.value;}
    step = next; syncIdentity(); render();
    if(creationHost){creationHost.step?.(step);focusCreationStep();if(step==="review"&&!Object.keys(draftErrors(state.values)).length)void prepareReview();}
    else {panels[step].focus({ preventScroll: true }); panels[step].scrollIntoView({ block: "start" });}
  }
  let renderedTasks;
  function render() {
    if (signal.aborted || !recovery) return;
    section.querySelector('.av2-view-header').hidden = Boolean(publication?.result) || state.deleted;
    section.querySelector('#'+headingId).textContent = state.restricted ? state.restriction === "archived" ? "Draft archived" : "Draft needs review" : !navigation ? "Create a Matter" : retained ? "Continue Matter draft" : "Create a Matter";
    const introduction = section.querySelector('.av2-view-header p'); if (introduction) introduction.hidden = Boolean(state.restricted);
    restrictedActions.forEach(control => { control.hidden = !state.restricted; });
    restrictedActions[0].textContent = state.restriction === "archived" ? "Restore draft" : "Contact support";
    restrictedActions[0].href = routeHref(state.restriction === "archived" ? withMatterReturn(`#/matters/${state.id}/archive`, route) : "#/help");
    section.setAttribute('aria-labelledby', publication?.result ? 'matter-publication-title' : state.deleted ? 'matter-draft-deleted-title' : headingId);
    if (publication) publication.root.hidden = state.deleted || !publication.visible;
    if(state.uncertain || state.conflict || state.error)recoveringSave=true;
    else if(!state.dirty)recoveringSave=false;
    recovery.render(state);
    if(creationHost){
      const [save,check]=recovery.root.querySelector('.av2-actions').children;
      save.textContent='Retry save';
      if(state.uncertain)save.hidden=true;
      check.textContent=state.action==='save'&&!state.conflict&&!state.missing&&!state.restricted?'Retry save':'Check saved draft';
      if(state.error&&state.action==='save'&&!state.conflict&&!state.missing&&!state.restricted&&!state.busy)
        recovery.root.querySelector('[role="status"]').textContent='We couldn’t confirm your save. Your edits are still here. Retry to check and save them safely.';
    }
    assistant?.update();
    if(stepHeading){stepHeading.hidden=step==='describe'||state.deleted||Boolean(publication?.result)||state.restricted;stepHeading.querySelector('h2').textContent=step==='review'?'Ready to publish':"Let’s shape your Matter";stepHeading.querySelector('p').hidden=step==='review';}
    if(saveStatus){saveStatus.hidden=recoveringSave||state.deleted||Boolean(publication?.result)||state.restricted||state.uncertain||Boolean(state.error)||(!state.dirty&&!state.id);saveStatus.textContent=state.dirty||state.busy?'Saving…':'Saved';}
    if(saveReview)saveReview.disabled=Boolean(publication?.locked)||!state.loaded||state.busy||state.uncertain||state.missing||state.deleted;
    if(assistant){assistant.launch.hidden=step!=="description"||Boolean(publication?.result)||state.deleted||state.restricted;assistant.refinePanel.hidden=assistant.refinePanel.hidden||step!=="description"||Boolean(publication?.result)||state.deleted||state.restricted;}
    if (recovery.root.dataset.compact === 'true') recovery.root.querySelector('[role="status"]').textContent = state.dirty ? 'Unsaved changes' : state.id ? 'Saved' : 'Not saved yet';

    for (const [key, control] of Object.entries(controls)) {
      const value = state.values[key] || "";
      if (key === "deadline") control.type = value && !validDraftDate(value) ? "text" : "date";
      if (control.tagName === "SELECT" && ![...control.options].some((option) => option.value === value)) control.append(node("option", { value, text: value }));
      if (control.value !== value) control.value = value;
      if(key==='compAmount'){
        const message=value?draftErrors(state.values).compAmount||'':'';
        control.setCustomValidity(message);
        if(!message&&value)delete errors.compAmount;
      }
      control.setAttribute("aria-invalid", String(Boolean(errors[key]))); errorNodes[key].textContent = errors[key] || "";
    }
    const taskSnapshot = JSON.stringify({tasks:state.values.tasks,manual:manualEntry()});
    if (taskSnapshot !== renderedTasks && !tasks.contains(document.activeElement)) renderTasks();
    renderedTasks = taskSnapshot;
    for (const [name, panel] of Object.entries(panels)) {
      panel.hidden = Boolean(publication?.result) || state.deleted || state.restricted || step !== name;
      panel.disabled = Boolean(publication?.locked) || !state.loaded || state.missing || state.deleted || (state.busy && state.action === "delete");
      if (step === name) stepButtons[name].setAttribute("aria-current", "step"); else stepButtons[name].removeAttribute("aria-current");
      stepButtons[name].disabled = Boolean(publication?.locked) || !state.loaded || state.deleted;
    }
    validation.textContent = navigation && Object.keys(errors).length ? "Complete the highlighted fields to continue. Your draft can still be saved." : "";
    if (step === "review" && state.values.tasks.length > 25) validation.textContent = "Use 25 tasks or fewer before publishing.";
    validation.hidden = Boolean(publication?.result) || state.deleted || Boolean(state.restricted);
    taskError.textContent = errors.tasks || "";
    publish.disabled = Boolean(publication?.locked) || state.busy || state.uncertain || state.missing || state.deleted || Object.keys(draftErrors(state.values)).length > 0;
    exit.disabled = Boolean(publication?.locked) || !state.loaded || state.busy || state.uncertain || state.missing || state.deleted;
    const returnFocused = document.activeElement === returnLink;
    returnLink.hidden = state.loaded && !state.dirty && !state.uncertain && !state.missing && !state.error;
    if (returnFocused && returnLink.hidden) menuToggle.focus({ preventScroll: true });
    remove.hidden = state.canDelete === false;
    remove.disabled = state.canDelete === false || Boolean(publication?.locked) || !state.id || state.busy || state.uncertain || state.missing || state.deleted;
    confirmDelete.disabled = remove.disabled;
    footer.hidden = nav.hidden = Boolean(publication?.result) || state.deleted || Boolean(state.restricted); deleted.hidden = !state.deleted;
    if(!navigation)footer.hidden=true;
    recovery.root.hidden = Boolean(publication?.result) || state.deleted || (!navigation && !recoveringSave && !state.error && !state.uncertain && !state.conflict && !state.missing && !state.restricted);
    if (state.deleted) confirmation.hidden = true;
    recovery.root.querySelectorAll("button").forEach((control) => { if (publication?.locked) control.disabled = true; });
    review.replaceChildren(node("h2", { className: "lpc-draft-visually-hidden", text: "Your Matter draft" }));
    const data = draftValues(state.values);
    const cents = dollarCents(data.compAmount);
    if(navigation) for (const key of (!navigation ? ["title","description","tasks","practiceArea","state","compAmount","experience","deadline"] : Object.keys(draftLabels))) {
      const text = key === "tasks" ? data.tasks.map((task, index) => `${index + 1}. ${task.title}`).join("\n") || "No tasks added"
        : key === "compAmount" && cents !== null ? currency(cents)
        : key === "deadline" && data.deadline ? globalThis.LPCBusinessDate.format(data.deadline) || data.deadline
        : data[key] || "Not specified";
      const edit = button('Edit', () => {
        changeStep(['description','tasks'].includes(key) ? 'description' : 'details');
        (controls[key] || tasks.querySelector('input'))?.focus();
      }, 'av2-draft-edit');
      edit.setAttribute('aria-label', `Edit ${draftLabels[key].toLowerCase()}`);
      review.append(node("div", {className:`av2-draft-review-item av2-draft-review-${key}`}, [node('div', {className:'av2-draft-review-label'}, [node("h3", { text: draftLabels[key] }), edit]), node("p", { text })]));
    }
    if (navigation && cents !== null) { const fee = Math.round(cents * 22 / 100); review.append(node("div", {className:"av2-draft-review-total"}, [node("h3", { text: "Estimated total due when you hire" }), node("p", { text: `${currency(cents)} compensation + ${currency(fee)} platform fee (22%) = ${currency(cents + fee)}` })])); }
    creationHost?.availability?.(state.loaded&&!publication?.locked&&!state.deleted&&!state.restricted);
    tasks.querySelectorAll('input').forEach(control=>control.canvasEditor?.update());
    surface?.update();
    canvasLayout?.update(step,state);
  }
  if (!navigation) {
    section.classList.add('av2-compose');
    saveStatus=node('span',{className:'av2-compose-save-status',role:'status','aria-live':'polite'});
    if(creationHost?.mountSaveStatus)creationHost.mountSaveStatus(saveStatus);
    else section.querySelector('.av2-draft-toolbar').append(saveStatus);
    stepHeading=node('div',{className:'av2-compose-step-heading'},[node('h2'),node('p',{className:'av2-muted',text:'Review what LPC pulled from your description.'})]);
    validation.after(stepHeading);
    const titleField=controls.title.closest('.av2-field');
    panels.description.querySelector('legend').textContent='Shape your Matter';
    panels.description.querySelector('legend').after(titleField);
    const practical=node('div',{className:'av2-compose-practical'},[]);
    for(const key of ['practiceArea','experience','state','deadline','compAmount'])practical.append(controls[key].closest('.av2-field'));
    const actions=panels.description.querySelector('.av2-draft-step-actions');
    actions.before(practical);
    actions.replaceChildren(button('← Back',()=>changeStep('describe'),'av2-secondary'),button('Review Matter →',()=>changeStep('review'),'av2-button'));
    publish.textContent='Publish Matter';
    panels.review.querySelector('.av2-draft-step-actions > button').textContent='← Back';
    saveReview=button('Save draft',async()=>{await session.save();},'av2-compose-example');publish.before(saveReview);
    panels.review.append(node('p',{className:'av2-compose-funding-note',text:'You’ll only fund the Matter when you hire a paralegal.'}));
    panels.description.querySelector('.av2-draft-task-heading h2').textContent='Tasks';
    panels.description.querySelector(':scope > button').textContent='+ Add task';
    surface=createDraftSurface({controls,panel:panels.description,tasks,review,state,canvas:Boolean(creationHost),edit:values=>{if(creationHost&&JSON.stringify(values.requirements)!==JSON.stringify(state.values.requirements))state.creationEditedFields=[...new Set([...(state.creationEditedFields||[]),'requirements'])];session.edit(values);},focus:key=>{changeStep('description');if(key==='tasks'&&!tasks.querySelector('input'))panels.description.querySelector(':scope > button').click();const control=controls[key] || (key==='requirements'?surface.input:tasks.querySelector('input'));if(key==='requirements'){surface.showAdditional();if(!creationHost)surface.add.click();}if(creationHost&&controls[key])surface.focus(key);else if(creationHost&&control?.canvasEditor)control.canvasEditor.open();else {if(key==='deadline')controls.deadline.hidden=false;control?.focus();}control?.scrollIntoView({block:'center'});}});
    assistant=createDraftComposer({canvas:Boolean(creationHost),retainSource:!retained,api:suggestionApi,ownerId:identity.id,signal,values:()=>state.values,memory:state,
      available:()=>state.loaded&&!state.restricted&&!state.uncertain&&!state.missing&&!state.deleted&&!publication.locked&&!publication.result,
      edit:changes=>{session.edit({...state.values,...changes});errors={};render();},go:changeStep});
    panels.describe=assistant.intro;
    stepHeading.append(assistant.launch);
    panels.description.before(assistant.intro,assistant.refinePanel);
    nav.replaceChildren();
    for(const [name,label] of [['describe','Describe'],['description','Shape'],['review','Review']]){
      stepButtons[name]=button(label,()=>changeStep(name));if(nav.childElementCount)nav.append(node('span',{text:'→','aria-hidden':'true'}));nav.append(stepButtons[name]);
    }
    review.setAttribute('aria-label','Matter posting preview');
    if(creationHost)canvasLayout=createCanvasLayout({section,assistant,panels,stepHeading,saveStatus,nav,publication,recovery,saveReview});
  }
  section.addEventListener('av2-matter-updated',event=>{
    for(const key of event.detail){
      const target=key==='tasks'?tasks:key==='requirements'?surface.requirements:controls[key]?.closest('.av2-field');
      if(!target)continue;target.classList.remove('av2-field-updated');void target.offsetWidth;target.classList.add('av2-field-updated');
      target.addEventListener('animationend',()=>target.classList.remove('av2-field-updated'),{once:true});
    }
  });
  render(); section.readiness = (async () => {
    if (!navigation && !state.id && !state.loaded && !state.profileDefaultsChecked) {
      state.profileDefaultsChecked = true;
      try {
        const defaults = await suggestionApi.readDraftDefaults({ownerId:identity.id,signal});
        if(!signal.aborted && defaults.ownerId===identity.id) {
          for(const key of ['practiceArea','state']) {
            const choices=key==='practiceArea'?draftPractices:draftStates;
            if(!state.values[key] && defaults[key] && choices.some(([v])=>v===defaults[key]))state.values[key]=state.base[key]=defaults[key];
          }
        }
      } catch { if (!signal.aborted) section.prepend(node("p", { className: "av2-muted", role: "status", text: "Your profile defaults couldn’t load. You can enter the Matter details below." })); }
    }
    await publication.check(); if (!publication.result) await session.check(); render(); if(creationHost&&step==="review"&&!publication.result&&!Object.keys(draftErrors(state.values)).length)await prepareReview(); })();
  section.manualEntry=assistant?.manual;
  section.canStartNew=()=>state.loaded&&!publication?.locked&&!state.deleted&&!state.restricted;
  section.flush=()=>session.save();
  section.creationState=state;
  function focusCreationStep(){
    const target=step==='describe'?assistant?.brief:step==='description'?(manualEntry()?controls.title:panels.description.querySelector('.av2-draft-field-title .av2-canvas-value')):panels.review.querySelector('.av2-compose-posting-title');
    if(target){if(target.tagName==='H2')target.tabIndex=-1;target.focus({preventScroll:true});}
  }
  section.focusCreation=focusCreationStep;
  section.getCreationStep=()=>step;
  return section;
}
