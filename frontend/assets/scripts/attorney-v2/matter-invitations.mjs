import { compactFilters } from "./presentation.mjs";
import { node, page, link, button, recoveryButton, setRecovery } from "./dom.mjs";
import { matterReturnHref, withMatterReturn } from "./matter-return.mjs";
import { profilePhoto, safeCandidateReturn } from "./candidate-model.mjs";
import { readInvitations, invitationStatus, invitationProfileHref, invitationFilters, invitationQuery, invitationInventory } from "./invitation-model.mjs";
const statuses = ["pending", "accepted", "declined", "expired", "unknown"];

export function createMatterInvitations(caseId, { api, signal, ownerId, current = false, showMatterTitle = true, query = new URLSearchParams() }) {
  let filters, invalid, generation = 0, result = null, reading = new AbortController();
  try { filters = invitationFilters(query); } catch (error) { filters = invitationFilters(); invalid = error; }
  const title = node("h2", { text: "Invited paralegals" }), status = node("p", { role: "status" }), body = node("div", { className: "av2-region-body" });
  const search = node("input", { type: "search", maxlength: "200", autocomplete: "off", value: filters.search });
  const selectedStatus = node("select", {}, [node("option", { value: "all", text: "All statuses" }), ...statuses.map(key => node("option", { value: key, text: invitationStatus(key) }))]);
  const sort = node("select", {}, [["newest", "Newest first"], ["oldest", "Oldest first"], ["name", "Name"]].map(([value, text]) => node("option", { value, text })));
  selectedStatus.value = filters.status; sort.value = filters.sort;
  const field = (text, control) => node("label", {}, [node("span", { text }), control]);
  const clear = button("Clear filters", () => navigate(invitationFilters()));
  const form = node("form", { className: "matter-application-filters", "aria-label": "Filter invitations" }, [field("Paralegal name", search), field("Status", selectedStatus), field("Sort", sort), node("button", { type: "submit", text: "Apply filters" }), clear]);
  if (!current) compactFilters(form, {placeholder:"Search people…", signal});
  form.addEventListener("submit", event => { event.preventDefault(); navigate({ page: 1, status: selectedStatus.value, sort: sort.value, search: search.value.trim() }); });
  const refresh = recoveryButton("Retry invited paralegals", () => void update());
  const previous = button("Previous invitations", () => navigate({ ...filters, page: filters.page - 1 }));
  const next = button("Next invitations", () => navigate({ ...filters, page: filters.page + 1 }));
  const first = button("Return to first page", () => navigate({ ...filters, page: 1 }));
  const navigation = node("nav", { className: "av2-actions", "aria-label": "Invitation pages" }, [previous, next, first]);
  const panel = node("section", { className: "matter-invitations matter-applications", "aria-label": "Invited paralegals", "data-matter-invitations": "", "data-av2-region": "matter-invitations" }, [node("div", { className: "av2-actions" }, [title, refresh]), form, status, body, navigation]);
  function href(view) { const next = invitationQuery(view, query); return `#/matters/${caseId}/invitations${next.size ? `?${next}` : ""}`; }
  function navigate(view) {
    if (!current && window.location.hash !== href(view)) { window.location.hash = href(view); return; }
    filters = view; invalid = null; search.value = view.search; selectedStatus.value = view.status; sort.value = view.sort; void update(true);
  }
  function clearCounts() { selectedStatus.options[0].textContent = "All statuses"; statuses.forEach((key, index) => { selectedStatus.options[index + 1].textContent = invitationStatus(key); }); }
  function row(invite) {
    const profile = invite.paralegal, destination = invitationProfileHref(invite, caseId, current, href(filters));
    const photo = node("img", { src: profilePhoto(profile.profileImage, profile.id, window.location.origin), alt: "", width: 44, height: 44 });
    photo.addEventListener("error", () => { photo.src = "/assets/avatar-placeholder.svg"; }, { once: true });
    return node("li", { className: "matter-invitation" }, [photo, node("div", {}, [
      destination ? link(profile.name, destination) : node("strong", { text: profile.name }),
      ...(!profile.available ? [node("p", { text: "Profile unavailable" })] : []),
      node("p", { text: invitationStatus(invite.status) }),
      node("p", { text: invite.invitedAt ? `Invited ${new Date(invite.invitedAt).toLocaleString()}` : "Invitation date unavailable" }),
      ...(invite.respondedAt ? [node("p", { text: `Responded ${new Date(invite.respondedAt).toLocaleString()}` })] : ["accepted", "declined"].includes(invite.status) ? [node("p", { text: "Response date unavailable" })] : []),
    ])]);
  }
  async function update(focus = false) {
    if (signal.aborted) return;
    const ticket = ++generation; reading.abort(); reading = new AbortController(); result = null;
    body.replaceChildren(); clearCounts(); title.textContent = "Invited paralegals"; status.textContent = "Loading invitations…";
    panel.dataset.state = "loading"; body.setAttribute("aria-busy", "true"); refresh.disabled = true;
    [previous, next, first].forEach(control => { control.hidden = true; control.disabled = true; });
    clear.hidden = !invalid && filters.page === 1 && filters.sort === "newest" && filters.status === "all" && !filters.search;
    try {
      if (invalid) throw invalid;
      const value = invitationInventory(readInvitations(await api.readMatterInvitations(caseId, { signal: reading.signal, ownerId }), caseId, ownerId), filters);
      if (signal.aborted || ticket !== generation) return;
      result = value; title.textContent = showMatterTitle ? value.caseTitle : "Invitations";
      const count = Object.values(value.counts).reduce((sum, total) => sum + total, 0);
      if (!current) { form.hidden = count === 0 && !filters.search && filters.status === "all";
        if (!count && value.complete) body.append(link("Find a paralegal to invite", `#/paralegals?caseId=${caseId}`, "av2-text-link")); }
      selectedStatus.options[0].textContent = `All statuses (${count}${value.complete ? "" : " readable"})`;
      statuses.forEach((key, index) => { selectedStatus.options[index + 1].textContent = `${invitationStatus(key)} (${value.counts[key]})`; });
      if (!value.complete) body.append(node("p", { className: "av2-notice", text: "Some invitation records could not be read. This list may be incomplete." }));
      if (value.invites.some(item => item.status === "accepted")) body.append(node("p", { text: "An accepted invitation does not confirm a hire. Review applications to continue hiring." }));
      if (value.invites.length) {
        body.append(node("ul", { className: "matter-invitation-list" }, value.invites.map(row)));
        const start = (value.page - 1) * 25 + 1;
        status.textContent = `${start}–${start + value.invites.length - 1} of ${value.total}${value.complete ? "" : " readable"} ${value.total === 1 ? "invitation" : "invitations"}`;
      } else status.textContent = value.page > value.pages ? "This page no longer has invitations. Return to the first page." : !value.complete ? "No readable invitations are available." : filters.search || filters.status !== "all" ? "No invitations match these filters." : "No invited paralegals yet.";
      panel.dataset.state = "ready";
    } catch (error) {
      if (signal.aborted || ticket !== generation) return;
      body.replaceChildren(); clearCounts(); panel.dataset.state = "error";
      status.textContent = invalid ? "This invitation link has invalid filters. Clear the filters to continue." : error.kind === "authorization" || error.kind === "authentication" || error.status === 404 ? "These invitations are no longer available to your account." : error.code === "INVITATION_CHANGED" ? "The invitations changed during this read. Refresh to review the current records." : "Invitations couldn’t load. Refresh to try again.";
    } finally {
      if (!signal.aborted && ticket === generation) {
        refresh.disabled = false; body.setAttribute("aria-busy", "false");
        previous.hidden = !result || result.page <= 1; previous.disabled = previous.hidden;
        next.hidden = !result || result.page >= result.pages; next.disabled = next.hidden;
        first.hidden = !result || result.page <= result.pages; first.disabled = first.hidden;
        if (focus) { title.tabIndex = -1; title.focus(); }
      }

      if (!signal.aborted) setRecovery(refresh, panel);
    }
  }
  signal.addEventListener("abort", () => { generation++; reading.abort(); panel.replaceChildren(); }, { once: true });
  panel.readiness = update(); return panel;
}

export function createInvitationsPage(route, identity, context) {
  const section = page("Invited paralegals");
  const directory = new URLSearchParams({ caseId: route.caseId, returnTo: safeCandidateReturn(`#/matters/${route.caseId}/invitations${route.query.size ? `?${route.query}` : ""}`) });
  section.firstChild.append(node("div", { className: "av2-actions" }, [link("Back to Matters", matterReturnHref(route)), link("Review applications", withMatterReturn(`#/matters/${route.caseId}/applications`, route)), link("Find a paralegal to invite", `#/paralegals?${directory}`)]));
  const invitations = createMatterInvitations(route.caseId, { ...context, ownerId: identity.id, query: route.query });
  section.append(invitations); section.readiness = invitations.readiness;
  return section;
}
