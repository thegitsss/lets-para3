import { compactFilters } from "./presentation.mjs";
import { createContextualBlock } from "./contextual-block.mjs";
import { createApplicationDecisions } from "./application-decisions.mjs";
import { createHiring } from "./hiring.mjs";
import { createHiringReturn } from "./pending-hire.mjs";
import { createPreEngagement } from "./pre-engagement.mjs";
import { createPrivateState } from "./private-state.mjs";
import { node, button, link, page, recoveryButton, setRecovery } from "./dom.mjs";
import { applicationStatus, applicationWarning, applicationProfileHref, applicationError } from "./application-model.mjs";
import { invitationStatus } from "./invitation-model.mjs";
import { createApplicationResume } from "./application-resume.mjs";
import { applicationFilters, applicationQuery, readApplicationInventory, APPLICATION_STATUSES } from "./application-inventory-model.mjs";
const para = text => node("p", { text });
const stamp = value => value ? new Date(value).toLocaleString() : "Date unavailable";
const filterStatus = value => ({ accepted: "Accepted", withdrawn: "Withdrawn", unknown: "Unavailable" })[value] || applicationStatus(value);

function application(item, caseId, current, selected, context) {
  const details = node("details", { className: "matter-application", "data-application": item.applicantId }, [node("summary", {}, [node("strong", { text: item.name }), node("span", { text: `${applicationStatus(item.status)}${item.starred ? " · Starred" : ""}` }), node("span", { text: item.appliedAt ? `Applied ${stamp(item.appliedAt)}` : "Application date unavailable" })])]);
  details.open = selected;
  const body = node("div", { className: "matter-application-body" });
  if (item.assigned) body.append(para("Assigned paralegal for this Matter"));
  if (item.status === "accepted") body.append(para("An accepted application does not confirm funding. Check the Matter's hiring and payment details."));
  if (current) item.warnings.forEach(key => body.append(node("p", { className: "av2-notice", text: applicationWarning(key) })));
  if (item.warnings.includes("records_differ")) body.append(para(`Application status: ${applicationStatus(item.status)}. Matter applicant entry: ${applicationStatus(item.matterStatus)}.`));
  body.append(node("h3", { text: "Cover letter" }), node("p", { className: "matter-application-letter", text: item.coverLetter || "No cover letter recorded." }));
  body.append(node("h3", { text: "Profile recorded with the application" }));
  const profile = item.profileSnapshot;
  if (!profile || ![profile.bio, profile.location, profile.availability, profile.languages.length, profile.specialties.length, profile.yearsExperience !== null].some(Boolean)) body.append(para("No profile snapshot recorded."));
  else {
    if (profile.bio) body.append(para(profile.bio));
    body.append(node("dl", {}, [["Location", profile.location], ["Availability", profile.availability], ["Experience", profile.yearsExperience === null ? "" : `${profile.yearsExperience} ${profile.yearsExperience === 1 ? "year" : "years"}`], ["Practice areas", profile.specialties.join(", ")], ["Languages", profile.languages.join(", ")]].filter(([, value]) => value).map(([label, value]) => node("div", {}, [node("dt", { text: label }), node("dd", { text: value })]))));
  }
  const href = applicationProfileHref(item, caseId, current, context.returnTo?.(item.applicantId));
  body.append(href ? link("View current profile and documents", href) : para(item.blocked ? "Further interaction with this paralegal is blocked. Recorded application history remains available." : "The current profile is unavailable."));
  if (item.resumeRecorded) body.append(createApplicationResume(caseId, item, context));
  else body.append(para("No résumé recorded."));
  if (item.linkedInRecorded) {
    if (item.linkedInReference) body.append(node("a", { href: item.linkedInReference, target: "_blank", rel: "noopener noreferrer", referrerpolicy: "no-referrer", text: "Open LinkedIn reference from application (new tab)" }), para("This is the address saved with the application. LinkedIn profile content may have changed since then."));
    else body.append(para("A LinkedIn reference was recorded, but its address could not be verified. Review the saved profile details above."));
  }
  body.append(node("h3", { text: "Recorded status history" }));
  body.append(item.history.length ? node("ol", {}, item.history.map(entry => node("li", { text: `${entry.from === "unknown" ? "" : `${applicationStatus(entry.from)} → `}${applicationStatus(entry.to)} · ${stamp(entry.at)}` }))) : para("No status changes are recorded."));
  if (item.withdrawnAt) body.append(para(`Withdrawn ${stamp(item.withdrawnAt)}`));
  if (item.invitations.length) body.append(node("h3", { text: "Invitations for this Matter" }), node("ul", {}, item.invitations.map(invite => node("li", { text: `${invitationStatus(invite.status)} · ${invite.respondedAt ? `Responded ${stamp(invite.respondedAt)}` : invite.invitedAt ? `Invited ${stamp(invite.invitedAt)}` : "Date unavailable"}` }))));
  if (item.blocked || !item.assigned && ["submitted", "pending", "viewed", "shortlisted"].includes(item.status)) body.append(createContextualBlock(caseId, { id: item.applicantId, name: item.name, mode: "application", blocked: item.blocked, canBlock: !item.blocked && !item.assigned }, { ...context, onRecorded: () => context.onSaved("", null) }));
  body.append(createApplicationDecisions(caseId, item, context));
  body.append(createPreEngagement(caseId, item, context));
  if (!current) body.append(createHiring(caseId, item, context));
  if (!current && !item.assigned && !item.blocked && ["submitted", "pending", "viewed", "shortlisted", "accepted"].includes(item.status)) body.append(createHiringReturn({ ...context, caseId, paralegalId: item.applicantId, name: item.name }));
  details.append(body);
  if (!current && item.warnings.length) return node("div", {className:"av2-application-record"}, [details, ...item.warnings.map(key=>node("p", {className:"av2-notice",text:applicationWarning(key)}))]);
  return details;
}

export function createMatterApplications(caseId, { api, signal, ownerId, current = false, showMatterTitle = true, applicantId = "", query = new URLSearchParams(), privateState = createPrivateState(), onDecisionRecorded }) {
  const initialQuery = new URLSearchParams(query);
  if (applicantId) initialQuery.set("applicantId", applicantId);
  let filters, invalid = null, generation = 0, result = null;
  try { filters = applicationFilters(initialQuery); } catch (error) { invalid = error; filters = applicationFilters(); filters.applicantId = initialQuery.get("applicantId") || ""; }
  let displayed = new AbortController(), reading = new AbortController();
  const confirmedDecisions = new Map();
  const status = node("p", { role: "status" }), title = node("h2", { text: "Applications" });
  const body = node("div", { className: "matter-applications-body" });
  const search = node("input", { type: "search", name: "applicationSearch", maxlength: "200", autocomplete: "off", value: filters.search });
  const selectedStatus = node("select", { name: "applicationStatus" }, [node("option", { value: "all", text: "All statuses" }), ...APPLICATION_STATUSES.map(key => node("option", { value: key, text: filterStatus(key) }))]);
  const sort = node("select", { name: "applicationSort" }, [["newest", "Newest first"], ["oldest", "Oldest first"], ["name", "Name"], ["starred", "Starred first"]].map(([value, text]) => node("option", { value, text })));
  selectedStatus.value = filters.status; sort.value = filters.sort;
  const field = (text, control) => node("label", {}, [node("span", { text }), control]);
  const submit = node("button", { type: "submit", text: "Apply filters" });
  const clear = button("Clear filters", () => navigate(applicationFilters()));
  const form = node("form", { className: "matter-application-filters", "aria-label": "Filter applications" }, [field("Applicant name", search), field("Status", selectedStatus), field("Sort", sort), submit, clear]);
  if (!current) compactFilters(form, {placeholder:"Search people…", signal});
  form.addEventListener("submit", event => { event.preventDefault(); navigate({ page: 1, sort: sort.value, status: selectedStatus.value, search: search.value.trim(), applicantId: "" }); });
  const refresh = recoveryButton("Retry applications", () => void update());
  const back = button("Previous applications", () => navigate({ ...filters, page: filters.page - 1 }));
  const forward = button("Next applications", () => navigate({ ...filters, page: filters.page + 1 }));
  const first = button("Return to first page", () => navigate({ ...filters, page: 1 }));
  const all = button("Return to all applications", () => navigate({ ...filters, applicantId: "" }));
  const navigation = node("nav", { className: "av2-actions", "aria-label": "Application pages" }, [back, forward, first]);
  const section = node("section", { className: "matter-applications", "data-matter-applications": "", "aria-label": "Application review" }, [node("div", { className: "av2-actions" }, [title, refresh, all]), form, status, body, navigation]);
  function href(view) {
    const next = applicationQuery(view, initialQuery);
    return `#/matters/${caseId}/applications${next.size ? `?${next}` : ""}`;
  }
  function navigate(view) {
    if (!current && window.location.hash !== href(view)) { window.location.hash = href(view); return; }
    filters = view; invalid = null; search.value = view.search; selectedStatus.value = view.status; sort.value = view.sort;
    void update(true);
  }
  const clearCounts = () => { selectedStatus.options[0].textContent = "All statuses"; APPLICATION_STATUSES.forEach((key, index) => { selectedStatus.options[index + 1].textContent = filterStatus(key); }); };
  const saved = (text, receipt) => {
    if (receipt?.kind === "application_decision") confirmedDecisions.set(receipt.applicantId, receipt);
    void update(true, text, receipt);
  };
  async function update(focus = false, savedMessage = "", receipt = null) {
    if (signal.aborted) return;
    const ticket = ++generation;
    reading.abort(); reading = new AbortController(); displayed.abort(); displayed = new AbortController();
    result = null; body.replaceChildren(); title.textContent = "Applications"; clearCounts();
    section.dataset.state = "loading"; body.setAttribute("aria-busy", "true"); status.classList.remove("matter-application-announcement"); status.textContent = "Loading applications…";
    refresh.disabled = true; [back, forward, first].forEach(control => { control.hidden = true; control.disabled = true; });
    all.hidden = !filters.applicantId; form.hidden = !!filters.applicantId;
    clear.hidden = !invalid && filters.page === 1 && filters.sort === "newest" && filters.status === "all" && !filters.search;
    try {
      if (invalid) throw invalid;
      const value = readApplicationInventory(await api.readApplicationInventory(caseId, filters, { signal: reading.signal, ownerId }), caseId, ownerId, filters);
      if (signal.aborted || ticket !== generation) return;
      result = value; title.textContent = showMatterTitle ? value.caseTitle : "Applications";
      if (value.archived) body.append(para("Archived Matter · Application history"));
      value.warnings.forEach(key => body.append(node("p", { className: "av2-notice", text: applicationWarning(key) })));
      const total = Object.values(value.counts).reduce((sum, number) => sum + number, 0);
      selectedStatus.options[0].textContent = `All statuses (${total}${value.complete ? "" : " readable"})`;
      APPLICATION_STATUSES.forEach((key, index) => { selectedStatus.options[index + 1].textContent = `${filterStatus(key)} (${value.counts[key]})`; });
      if (value.applications.length) {
        value.applications.forEach(item => body.append(application(item, caseId, current, !!filters.applicantId || current && value.applications.length === 1, { api, signal: displayed.signal, ownerId, privateState, returnTo: applicantId => href({ ...filters, applicantId }), onSaved: saved })));
        const start = (value.page - 1) * 25 + 1, end = start + value.applications.length - 1;
        status.textContent = filters.applicantId || value.total === 1 ? "" : `${start}–${end} of ${value.total}${value.complete ? "" : " readable"} ${value.total === 1 ? "application" : "applications"}`;
      } else {
        status.textContent = filters.applicantId ? "This application is no longer available in this Matter's records." : value.page > value.pages ? "This page no longer has applications. Return to the first page." : !value.complete ? "No readable applications are available in these records." : filters.search || filters.status !== "all" ? "No applications match these filters." : "No applications have been recorded for this Matter.";
      }
      for (const [key, entry] of privateState.applicationDecisions) {
        if (key.startsWith(`${caseId}:`) && entry.pending && !value.applications.some(item => key === `${caseId}:${item.applicantId}`)) body.append(createApplicationDecisions(caseId, { applicantId: key.slice(caseId.length + 1), applicationId: entry.pending.applicationId }, { api, signal: displayed.signal, ownerId, privateState, onSaved: saved }));
      }
      if (savedMessage) {
        if (receipt?.kind === "application_decision") {
          status.classList.toggle("matter-application-announcement", !status.textContent);
          status.prepend(node("span", { className: "matter-application-announcement", text: `${savedMessage} ` }));
        }
        else status.textContent = `${savedMessage} ${status.textContent}`.trim();
      }
      section.dataset.state = "ready";
      for (const receipt of confirmedDecisions.values()) onDecisionRecorded?.(receipt);
      confirmedDecisions.clear();
    } catch (error) {
      if (signal.aborted || ticket !== generation) return;
      body.replaceChildren(); clearCounts(); status.textContent = invalid ? "This application link has invalid filters. Clear the filters or return to all applications." : applicationError(error); section.dataset.state = "error";
    } finally {
      if (!signal.aborted && ticket === generation) {
        refresh.disabled = false;
        back.hidden = !result || !!filters.applicantId || result.page <= 1; back.disabled = back.hidden;
        forward.hidden = !result || !!filters.applicantId || result.page >= result.pages; forward.disabled = forward.hidden;
        first.hidden = !result || !!filters.applicantId || result.page <= result.pages; first.disabled = first.hidden;
        body.setAttribute("aria-busy", "false");
        if (focus) { title.tabIndex = -1; title.focus(); }
      }

      if (!signal.aborted) setRecovery(refresh, section);
    }
  }
  signal.addEventListener("abort", () => { generation++; reading.abort(); displayed.abort(); confirmedDecisions.clear(); body.replaceChildren(); section.replaceChildren(); }, { once: true });
  section.readiness = update(); return section;
}

export function createApplicationsPage(route, identity, context) {
  const section = page("Review applications");
  section.firstChild.append(node("div", { className: "av2-actions" }, [link("Back to Matters", "#/matters?view=applications"), link("View invited paralegals", `#/matters/${route.caseId}/invitations`)]));
  const applications = createMatterApplications(route.caseId, { ...context, ownerId: identity.id, query: route.query });
  section.append(applications);
  section.readiness = applications.readiness; return section;
}
