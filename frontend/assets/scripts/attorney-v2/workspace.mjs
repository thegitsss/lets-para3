import { createMatterInvitations } from "./matter-invitations.mjs";
import { createMatterPicker } from "./matter-picker.mjs";
import { conversationAvatar } from './conversation-avatar.mjs';
import { createMatterArchive } from "./matter-archive.mjs";
import { createMatterModeration } from "./matter-moderation.mjs";
import { createContextualBlock } from "./contextual-block.mjs";
import { setSupportMatterContext } from "../utils/support-workspace-context.mjs";
import { matterReturnHref, withMatterReturn } from "./matter-return.mjs";
import { createWorkspaceCompletion } from "./workspace-completion.mjs";
import { createWorkspaceDisputes } from "./workspace-disputes.mjs";
import { createWorkspaceFunding } from "./workspace-funding.mjs";
import { createWorkspaceWithdrawal } from "./workspace-withdrawal.mjs";
import { node, link, recoveryButton, setRecovery } from "./dom.mjs";
import { MATTER_TABS, readMatter, acknowledgeApplicationDecision, matterLink, matterNotice, dateLabel, timeLabel, text, objectId } from "./workspace-model.mjs";
import { createMatterApplications } from "./matter-applications.mjs";
import { createWorkspaceFiles } from "./workspace-files.mjs";
import { createMatterReceipt } from "./matter-receipts.mjs";
import { createMatterNotes } from "./matter-notes.mjs";
import { createWorkspaceWork } from "./workspace-work.mjs";
import { createWorkspaceMessages } from "./workspace-messages.mjs";
import { createWorkspaceDates } from "./workspace-dates.mjs";
import { financialRefresh } from "./financial-section.mjs";
const fact = (label, value) => node("div", {}, [node("dt", { text: label }), node("dd", { text: value || "Not recorded" })]);
const titleCase = value => value[0].toUpperCase() + value.slice(1);
function overview(matter, context) {
  const overview = matter.matterExperience.overview;
  const section = node("section", { "aria-label": "Matter overview" }, [node("p", { className: "av2-preserve-lines", text: matter.details || overview.summary || "No description is recorded." }), node("dl", { className: "av2-matter-facts" }, [fact("Attorney", overview.attorney), fact("Paralegal", overview.paralegal || "Not assigned"), fact("Practice area", overview.practiceArea ? overview.practiceArea[0].toUpperCase() + overview.practiceArea.slice(1) : ""), fact("Jurisdiction", overview.jurisdiction), fact("Deadline", dateLabel(overview.deadline)), fact("Work started", dateLabel(overview.hiredAt))])]);
  const block = matter.blockStatus;
  if (/^[a-f0-9]{24}$/i.test(block?.counterpartyId || "") && block.counterpartyRole === "paralegal" && (block.canBlock === true || block.blocked === true)) section.append(createContextualBlock(matter.id, { id: block.counterpartyId, name: "this paralegal", mode: "finalized", canBlock: block.canBlock === true, blocked: block.blocked === true }, context));
  const notes = createMatterNotes(matter.id, { ...context, embedded: true, compact: true }); const moderation = createMatterModeration(matter.id, { ...context, embedded: true, compact: true, openNotes: () => notes.openEditor?.(), onRecorded: () => void notes.refresh() }); section.append(moderation, notes); section.readiness = Promise.all([notes.readiness, moderation.readiness]); return section;
}
function deadlines(matter, context) {
  const dates = createWorkspaceDates(matter.id, context);
  const section = node("section", { "aria-label": "Matter deadlines" }, [node("h2", { text: "Deadlines" }), node("p", { text: `Matter deadline: ${dateLabel(matter.matterExperience.overview.deadline)}` }), dates]);
  section.readiness = dates.readiness; section.sync = () => dates.sync(); return section;
}
function activity(matter, context) {
  const section = node("section", { "aria-label": "Matter activity" }, [node("h2", { text: "Activity" })]);
  section.append(node("p", { text: `Matter deadline: ${dateLabel(matter.matterExperience.overview.deadline)}` }));
  section.append(link("View deadlines and your calendar", matterLink(matter.id, "deadlines", context.route.query)));
  const status = node("p", { role: "status", text: "Loading status history…" }), body = node("div"); section.append(status, body);
  const historyRead = (async () => {
    try {
      const history = await context.api.readWorkspaceHistory(matter.id, context);
      if (context.signal.aborted) return;
      if (history.caseId !== matter.id || !Array.isArray(history.items) || history.items.some(item => !text(item.label) || !Number.isFinite(Date.parse(item.at)))) throw new Error("invalid_history");
      status.textContent = history.complete === true ? "" : "Some status history could not be loaded. Refresh the Matter to try again.";
      const events = [...history.items.map(item => ({...item, label:`Status: ${item.label}`})), ...matter.matterExperience.activity.filter(item => text(item.label))].sort((a,b) => (Date.parse(b.at)||0) - (Date.parse(a.at)||0));
      body.append(node("ol", { className: "av2-matter-timeline" }, events.map(item => node("li", {}, [node("strong", { text: item.label }), node("time", { text: timeLabel(item.at) })]))));
      if (!events.length) body.append(node("p", { text: "No activity is recorded." }));
    } catch (error) { if (!context.signal.aborted) { body.replaceChildren(); status.textContent = "Activity couldn’t load. Refresh the Matter to try again."; } }
  })(); section.readiness = historyRead; return section;
}
function financials(matter, context) {
  const section = node("section", { className: "av2-matter-financials", "aria-label": "Matter financials" });
  const funding = createWorkspaceFunding(matter.id, context), withdrawal = createWorkspaceWithdrawal(matter.id, context), completion = createWorkspaceCompletion(matter.id, context), disputes = createWorkspaceDisputes(matter.id, context), receipt = createMatterReceipt(matter.id, { ...context, showMatterTitle: false, compact: true });
  section.append(funding, withdrawal, completion, disputes, receipt);
  section.readiness = Promise.all([funding.readiness, withdrawal.readiness, completion.readiness, disputes.readiness, receipt.readiness]); section.sync = () => Promise.all([funding.sync(), withdrawal.sync(), completion.sync(), disputes.sync(), receipt.sync()]); return section;
}
export function createMatterWorkspace(route, identity, context) {
  const caseId = route.caseId, tab = route.tab;
  const embeddedConversation = context.presentation === "conversation" && tab === "messages";
  const section = node("section", { className: "av2-view av2-matter-workspace", "data-matter-workspace": caseId, "aria-labelledby": "av2-page-title" });
  const cached = context.privateState.workspaceHeaders.get(caseId);
  const title = node(embeddedConversation ? "h2" : "h1", { id: embeddedConversation ? "av2-thread-title" : "av2-page-title", text: cached?.title || "Matter" });
  const titleRow = node("div", { className: "av2-matter-title-row" }, [title]);
  const header = node("header", { className: "av2-matter-header" }, [link("Back to Matters", matterReturnHref(route)), titleRow]);
  const headerFacts = node("p", { className: "av2-matter-header-facts" });
  const nextActionRow = node("div", { className: "av2-matter-next-action" });
  if (!embeddedConversation) header.append(headerFacts, nextActionRow);
  if (!embeddedConversation) {
    const switcher = createMatterPicker({ label: "Switch Matter", triggerLabel: "Switch Matter", dialogTitle: "Switch Matter", allowClear: false, currentId: caseId, ownerId: identity.id, api: context.api, signal: context.signal });
    switcher.element.setAttribute("data-av2-matter-switcher", "");
    switcher.input.addEventListener("change", () => {
      if (!context.signal.aborted && objectId(switcher.input.value) && switcher.input.value !== caseId) window.location.hash = matterLink(switcher.input.value, "overview", route.query);
    });
    const back = header.firstElementChild;
    header.prepend(node("div", { className: "av2-matter-navigation" }, [back, switcher.element]));
  }
  const status = node("p", { role: "status", text: "Loading Matter…" }), body = node("div", { className: "av2-matter-body" });
  const statusRow = tab === "financials" ? node("div", { className: "av2-financial-status-row" }, [status, link("View payment history", `#/payments?caseId=${encodeURIComponent(caseId)}`)]) : status;
  const refresh = tab === "financials" ? financialRefresh("Refresh Matter", () => void load()) : recoveryButton("Retry Matter", () => void load()), navigation = node("nav", { className: "av2-matter-tabs", "aria-label": "Matter sections" });
  refresh.setLabel?.("Refresh Matter", true);
  for (const name of MATTER_TABS) { const anchor = link(titleCase(name), matterLink(caseId, name, route.query)); if (tab === name || tab === "manage" && name === "overview" || tab === "invitations" && name === "applications") anchor.setAttribute("aria-current", "page"); navigation.append(anchor); }
  const tabObserver = new ResizeObserver(() => {
    const selected = navigation.querySelector('[aria-current="page"]');
    if (!selected) return;
    const frame = navigation.getBoundingClientRect(), item = selected.getBoundingClientRect();
    if (item.right > frame.right) navigation.scrollLeft += item.right - frame.right;
    else if (item.left < frame.left) navigation.scrollLeft -= frame.left - item.left;
  });
  tabObserver.observe(navigation);
  context.signal.addEventListener('abort', () => tabObserver.disconnect(), { once: true });
  if (tab === "financials") titleRow.append(refresh);
  titleRow.append(statusRow); header.append(navigation); section.append(header, body, ...(tab === "financials" ? [] : [refresh])); section.dataset.tab = tab;
  const participant = node("p", { className:"av2-thread-participant" });
  const avatar = conversationAvatar(context.conversationParticipant, 'av2-thread-header-avatar');
  if (embeddedConversation) {
    section.classList.add("av2-inbox-workspace");
    section.setAttribute("aria-labelledby", title.id);
    header.replaceChildren(avatar, node("div", {className:"av2-thread-identity"}, [participant, title, status]), link("View Matter", matterLink(caseId, 'overview', route.query), "av2-text-link av2-thread-matter-link"));
    header.querySelector(".av2-thread-matter-link").setAttribute("aria-label", "View Matter");
  }
  let clearAssistantContext = () => {};
  let child = new AbortController(), busy = false, current = null, checking = false, content = null, archiveAction = null, stream = null, scheduled = null, lastPresence = 0, presenceStarted = false;
  const decisions = new Map(); let decisionRefresh = false;
  function statusText(value) {
    if (embeddedConversation) return matterNotice(value) || (value.readOnly ? value.matterExperience.header.status.label : "");
    if (tab !== "financials") return matterNotice(value) || value.matterExperience.header.status.label;
    if (value.archived) return "Archived";
    if (value.status === "disputed" || value.termination?.status === "disputed") return "Under review";
    if (value.readOnly && !["completed", "closed", "cancelled", "canceled", "expired"].includes(value.status)) return "Read only";
    return value.matterExperience.header.status.label;
  }
  function clearSupportContext() { clearAssistantContext(); clearAssistantContext = () => {}; }
  function rememberMatter(value) {
    clearSupportContext();
    clearAssistantContext = setSupportMatterContext({ ownerId: identity.id, role: "attorney", matterId: value.id || value._id, routeMatterId: caseId, currentTab: tab, availableMatterTabs: value.matterExperience.sections.map(section => section.id), status: value.status, relationship: value.matterExperience.header.relationship, signal: context.signal });
    current = value; title.textContent = value.title; document.title = `${value.title} · ${titleCase(tab)} – Let’s-ParaConnect`;
    const overview = value.matterExperience.overview;
    headerFacts.textContent = [
      overview.paralegalId && overview.paralegal ? `Paralegal: ${overview.paralegal}` : "",
      overview.deadline ? `Due ${dateLabel(overview.deadline)}` : "",
    ].filter(Boolean).join(" · ");
    nextActionRow.replaceChildren();
    const next = value.matterExperience.header.primaryAction;
    if (!embeddedConversation && next && MATTER_TABS.includes(next.tab) && next.tab !== tab && value.matterExperience.sections.some(section => section.id === next.tab)) {
      nextActionRow.append(link(next.label, matterLink(caseId, next.tab, route.query), "av2-secondary"));
      if (next.detail) nextActionRow.append(node("span", { text: next.detail }));
    }
    if (embeddedConversation) {
      participant.textContent = value.matterExperience.overview.paralegal || context.conversationParticipant?.name || "Participant unavailable";
      avatar.replaceChildren(...conversationAvatar({...context.conversationParticipant, name:participant.textContent}).childNodes);
    }
    context.privateState.workspaceHeaders.set(caseId, { title: value.title });
    if (context.privateState.workspaceHeaders.size > 10) context.privateState.workspaceHeaders.delete(context.privateState.workspaceHeaders.keys().next().value);
    if (archiveAction) archiveAction.hidden = !value.archived && !value.archiveReadyAt;
  }
  async function readStableMatter() {
    const read = () => context.api.readWorkspaceMatter(caseId, { signal: context.signal, ownerId: identity.id });
    let value;
    try { value = await read(); }
    catch (error) {
      // A recorded response can change the snapshot during this read. Recheck
      // once through the same owner boundary; other failures still clear access.
      if (context.signal.aborted || error.status !== 409 || !["WORKSPACE_CHANGED", "APPLICATION_REVIEW_CHANGED"].includes(error.code)) throw error;
      value = await read();
    }
    return readMatter(value, caseId);
  }
  const clear = (forgetDrafts = false) => { clearSupportContext(); stopPresence(); disconnect(); child.abort(); decisions.clear(); decisionRefresh = false; if (forgetDrafts) privateStateClear(); body.replaceChildren(); current = null; archiveAction = null; context.privateState.workspaceHeaders.delete(caseId); title.textContent = "Matter unavailable"; participant.textContent = ""; headerFacts.textContent = ""; nextActionRow.replaceChildren(); };
  function privateStateClear() { context.privateState.funding.delete(caseId); context.privateState.withdrawals.delete(caseId); context.privateState.disputes.delete(caseId); context.privateState.completions.delete(caseId); context.privateState.conversations.delete(caseId); context.privateState.workReviews.delete(caseId); context.privateState.dateReviews.delete(caseId); context.privateState.fileReviews.delete(caseId); }
  async function load() {
    if (busy || checking || context.signal.aborted) return;
    clearSupportContext();
    decisions.clear(); decisionRefresh = false;
    busy = true; refresh.disabled = true; section.dataset.state = "loading"; status.textContent = "Loading Matter…"; child.abort(); child = new AbortController(); body.replaceChildren(); header.querySelector(".av2-workspace-options")?.remove(); archiveAction = null;
    try {
      const value = await readStableMatter();
      if (context.signal.aborted) return;
      rememberMatter(value);
      const options = { ...context, signal: child.signal, ownerId: identity.id, route, hasArchiveLink: tab !== "financials" && Boolean(value.archived || value.archiveReadyAt), hasClosedWorkNotice: !value.archived && value.termination?.status !== "disputed" && ["completed", "closed", "cancelled", "canceled", "expired"].includes(value.status), retained: Boolean(value.archived || value.readOnly || ["completed", "closed"].includes(value.status)) };
      status.textContent = statusText(value);
      const actionLinks = node("div", { className: "av2-actions" }, [link("Invitations", withMatterReturn(`#/matters/${caseId}/invitations`, route)), link("Archive options", withMatterReturn(`#/matters/${caseId}/archive`, route))]);
      actionLinks.append(link("Get help", `#/help?caseId=${caseId}`));
      archiveAction = link("Download Matter archive", withMatterReturn(`#/matters/${caseId}/export`, route), "av2-text-link av2-parent-archive");
      archiveAction.hidden = !value.archived && !value.archiveReadyAt; actionLinks.append(archiveAction); const actions = node("details", { className:"av2-workspace-options" }, [node("summary", {text:"Matter options"}), actionLinks]); if (!embeddedConversation) header.append(actions);
      actions.addEventListener("keydown", event => { if (event.key === "Escape") { actions.open = false; actions.querySelector("summary").focus(); } });
      document.addEventListener("pointerdown", event => { if (!actions.contains(event.target)) actions.open = false; }, {signal:child.signal});
      const panels = { overview, manage: overview, invitations: (_matter, opts) => createMatterInvitations(caseId, {...opts, showMatterTitle:false, query:route.query}), archive: (_matter, opts) => createMatterArchive(caseId, {...opts, compact:true, onRecorded:() => void load()}), work: (_matter, opts) => createWorkspaceWork(caseId, opts), deadlines, activity, financials, applications: (_matter, opts) => createMatterApplications(caseId, { ...opts, showMatterTitle: false, query: route.query, onDecisionRecorded: receipt => {
        if (opts.signal.aborted || context.signal.aborted) return;
        decisions.set(receipt.applicantId, receipt); decisionRefresh = true; void checkAccess();
      } }), files: (_matter, opts) => createWorkspaceFiles(caseId, opts), messages: (_matter, opts) => createWorkspaceMessages(caseId, opts) };
      content = panels[tab](value, options); body.append(content); section.dataset.state = "ready";
      await content.readiness;
      if (!child.signal.aborted) { connect(); void presence(); }
    } catch (error) {
      if (context.signal.aborted) return;
      clear([401, 403, 404].includes(error.status)); section.dataset.state = "error"; status.textContent = [401, 403, 404].includes(error.status) ? "This Matter is no longer available to your account." : error.code === "WORKSPACE_CHANGED" ? "This Matter changed while loading. Refresh to review its current details." : "The Matter couldn’t load. Try again.";
    } finally { if (!context.signal.aborted) { busy = false; refresh.disabled = false; refresh.setLabel?.("Refresh Matter", Boolean(current && section.dataset.state === "ready")); if (decisionRefresh) void checkAccess(); }
      if (!context.signal.aborted) setRecovery(refresh, section);
    }
  }
  async function checkAccess() {
    if (!current || busy || checking || context.signal.aborted || document.visibilityState !== "visible") return;
    checking = true; refresh.disabled = true;
    decisionRefresh = false; const acknowledged = new Map(decisions);
    try {
      const value = await readStableMatter();
      if (context.signal.aborted) return;
      for (const [applicantId, receipt] of acknowledged) {
        current = acknowledgeApplicationDecision(current, value, receipt);
        if (decisions.get(applicantId) === receipt) decisions.delete(applicantId);
      }
      // Financial panels recheck their own reviews without replacing drafts.
      // Keep the surrounding title, status, archive access and Help context in
      // step with that same authorized Matter read.
      if (tab === "financials" && JSON.stringify(value) !== JSON.stringify(current)) rememberMatter(value);
      if (JSON.stringify(value) !== JSON.stringify(current)) status.textContent = "This Matter has changed. Refresh the Matter to review its current details.";
      else status.textContent = statusText(value);
      await content?.sync?.();
      if (!context.signal.aborted) await presence();
    } catch (error) { if (!context.signal.aborted) { clear([401, 403, 404].includes(error.status)); section.dataset.state = "error"; status.textContent = [401, 403, 404].includes(error.status) ? "This Matter is no longer available to your account." : "Matter access could not be verified. Refresh to try again."; } }
    finally { checking = false; if (!context.signal.aborted && !busy) { refresh.disabled = false; refresh.setLabel?.("Refresh Matter", Boolean(current && section.dataset.state === "ready")); if (decisionRefresh) void checkAccess(); }
      if (!context.signal.aborted) setRecovery(refresh, section);
    }
  }
  async function presence() {
    if (!content?.presenceActive?.() || context.signal.aborted) { stopPresence(); return; }
    if (Date.now() - lastPresence < 20000) return;
    presenceStarted = true;
    lastPresence = Date.now();
    try { await context.api.setWorkspacePresence(caseId, true, { ownerId: identity.id, signal: context.signal }); }
    catch { lastPresence = 0; /* Let the next access check retry; presence does not establish access. */ }
  }
  function stopPresence() {
    if (!presenceStarted) return;
    presenceStarted = false; lastPresence = 0;
    // Route disposal has already aborted its signal. This bounded, owner-checked
    // clear must be allowed to finish; expiration covers failed/unloaded requests.
    void context.api.setWorkspacePresence(caseId, false, { ownerId: identity.id }).catch(() => {
      console.warn("[LPC] Workspace presence could not be cleared; the lease will expire automatically.");
    });
  }
  function disconnect() { stream?.close(); stream = null; if (scheduled) clearTimeout(scheduled); scheduled = null; }
  function connect() {
    disconnect();
    if (!current || document.hidden || context.signal.aborted || typeof EventSource !== "function") return;
    stream = new EventSource(`/api/cases/${caseId}/stream`);
    const schedule = () => { if (!scheduled) scheduled = setTimeout(() => { scheduled = null; void checkAccess(); }, 150); };
    for (const event of ["messages", "documents", "tasks", "case", "status", "projection", "refresh"]) stream.addEventListener(event, schedule);
    // Native EventSource owns reconnects; the interval provides bounded fallback.
  }
  function visibility() {
    if (document.hidden) { disconnect(); stopPresence(); }
    else { connect(); void checkAccess(); }
  }
  const interval = setInterval(() => void checkAccess(), 15000);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("pagehide", stopPresence);
  context.signal.addEventListener("abort", () => { stopPresence(); clearInterval(interval); disconnect(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", stopPresence); child.abort(); current = null; content = null; section.replaceChildren(); }, { once: true });
  connect();
  section.readiness = load(); return section;
}
