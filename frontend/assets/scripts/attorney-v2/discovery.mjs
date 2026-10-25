import { renderCandidateProfile } from "./candidate-profile.mjs";
import { availabilityDot } from "./availability-dot.mjs";
import { createSaveParalegal, createSavedParalegals } from "./saved-paralegals.mjs";
import { createDirectoryFilterMenu, renderDirectoryFilterChips, createDirectorySortControl, fitDirectoryPopover } from "../utils/directory-filter-menu.mjs";
import { node, page, link, button, region } from "./dom.mjs";
import { field } from "./tasks.mjs";
import { states, specialties } from "./directory-options.mjs";
import { normalizePresentation } from "../authenticated-object-search.mjs";
import { directoryQuery, candidateContext, candidateHref, safeCandidateReturn, legacyCandidateHref, experience, profilePhoto, projectCandidate, safeSignedUrl } from "./candidate-model.mjs";
import { createInvitationActions } from "./invitation-actions.mjs";

const stateCodes = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const displayState = value => String(value || "").replace(/\b[A-Z]{2}\b/g, code => states[stateCodes.indexOf(code)] || code);
function photo(profile) {
  const image = node("img", { src: profilePhoto(profile.avatarURL || profile.profileImage, profile.id, location.origin), alt: "", width: "64", height: "64", loading: "lazy" });
  image.addEventListener("error", () => { image.src = "/assets/avatar-placeholder.svg"; }, { once: true });
  return image;
}
function directoryIcon(pathData) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", pathData); svg.append(path);
  return svg;
}
export function createDirectory(route, { api, signal, ownerId }) {
  const view = page("Find a Paralegal");
  view.classList.add("av2-directory");
  const saved = route.query.get('view') === 'saved';
  const prior = safeCandidateReturn(route.query.get("returnTo"));
  const matterReturn = prior?.startsWith("#/matters") ? prior : null;
  const contextQuery = () => { const query = candidateContext(route.query); if (matterReturn) query.set("returnTo", matterReturn); return query; };
  const listQuery = directoryQuery(route.query);
  for (const [key, value] of contextQuery()) listQuery.set(key, value);
  const listHref = saved => { const query = new URLSearchParams(listQuery); if (saved) query.set('view', 'saved'); return `#/paralegals?${query}`; };
  const tabs = node('nav', { className: 'av2-directory-tabs', 'aria-label': 'Paralegal lists' });
  const savedCount = node('span', { className: 'av2-saved-count', 'aria-hidden': 'true', hidden: '' });
  for (const [label, href, active] of [['Browse paralegals', listHref(false), !saved], ['Saved paralegals', listHref(true), saved]]) {
    const item = link(label, href); if (active) item.setAttribute('aria-current', 'page');
    if (label === 'Saved paralegals') item.append(savedCount);
    tabs.append(item);
  }
  view.append(tabs);
  if (matterReturn) view.firstChild.append(link("Back to Matter", matterReturn));
  if (saved) { const list = createSavedParalegals({ api, signal, ownerId, context: contextQuery(), returnTo: listHref(true), onCount(total) { savedCount.hidden = total === null; savedCount.textContent = total === null ? '' : String(total); } }); view.append(list); view.readiness = list.readiness; return view; }
  const query = directoryQuery(route.query);
  const filters = node("form", { className: "av2-card", "aria-label": "Paralegal filters" });
  const search = node("input", { type: "search", maxlength: "200", value: query.get("q") || "" });
  let sortValue = query.get('sort');
  const chips = node('div', { className: 'lpc-directory-filter-chips', 'aria-label': 'Active filters', hidden: '' });
  const filterToggle = node('button', { type: 'button', className: 'lpc-directory-icon', 'aria-label': 'Open filters', 'aria-expanded': 'false', title: 'Filter paralegals' });
  filterToggle.append(directoryIcon("M3 6h8m4 0h6M3 12h2m4 0h12M3 18h12m4 0h2M11 3v6M5 9v6m10 0v6"));
  let filterMenu;
  const close = () => { filterMenu.element.hidden = true; filterToggle.setAttribute('aria-expanded', 'false'); filterMenu.resetView(); filterToggle.focus(); };
  const apply = value => {
    query.set('page', '1'); query.set('sort', sortValue);
    for (const [key, val] of Object.entries({ q: search.value.trim(), minYears: value.minYears, location: value.location.join('|'), practice: value.practice.join('|') })) {
      if (val) query.set(key, val); else query.delete(key);
    }
    for (const key of [...listQuery.keys()]) listQuery.delete(key);
    for (const [key, val] of query) listQuery.set(key, val);
    const url = new URLSearchParams(query);
    for (const [key, val] of contextQuery()) { url.set(key, val); listQuery.set(key, val); }
    history.replaceState(history.state, '', `#/paralegals?${url}`);
    tabs.querySelectorAll('a').forEach((item, index) => item.href = listHref(index === 1));
    renderDirectoryFilterChips(chips, value, next => { filterMenu.setValue(next); apply(next); }, filterToggle);
    const count = filterMenu.count();
    filterToggle.setAttribute('aria-label', count ? `Open filters, ${count} active filter${count === 1 ? '' : 's'}` : 'Open filters');
    void results.refresh();
  };
  filterMenu = createDirectoryFilterMenu({ states, specialties, value: {
    practice: (query.get('practice') || '').split('|').filter(Boolean),
    location: (query.get('location') || '').split('|').filter(Boolean),
    minYears: query.get('minYears') || '',
  }, onChange: apply, onClose: close, onResize: () => { if (filterMenu) fitDirectoryPopover(filterMenu.element, filterToggle); } });
  filterMenu.element.hidden = true;
  const fit = () => fitDirectoryPopover(filterMenu.element, filterToggle);
  filterToggle.addEventListener('click', () => {
    const open = filterMenu.element.hidden;
    filterMenu.element.hidden = !open; filterToggle.setAttribute('aria-expanded', String(open));
    if (open) fit(); else filterMenu.resetView();
  });
  document.addEventListener('click', event => { if (!filterMenu.element.hidden && !filterMenu.element.contains(event.target) && !filterToggle.contains(event.target)) { filterMenu.element.hidden = true; filterToggle.setAttribute('aria-expanded', 'false'); filterMenu.resetView(); } }, { signal });
  filterMenu.element.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } });
  window.addEventListener('resize', fit, { signal }); window.addEventListener('scroll', fit, { signal, passive: true }); window.visualViewport?.addEventListener('resize', fit, { signal });
  const sortControl = createDirectorySortControl({ value: sortValue, signal, onChange: value => { sortValue = value; apply(filterMenu.value()); } });
  filters.classList.add('av2-directory-controls');
  filters.append(field('Search profiles', search), node('button', { type: 'submit', className: 'av2-secondary', text: 'Search' }), sortControl, filterToggle);
  filters.addEventListener('submit', event => { event.preventDefault(); apply(filterMenu.value()); });
  renderDirectoryFilterChips(chips, filterMenu.value(), next => { filterMenu.setValue(next); apply(next); }, filterToggle);
  view.append(filters, chips);
  document.body.append(filterMenu.element);
  signal.addEventListener('abort', () => filterMenu.element.remove(), { once: true });
  const results = region("Paralegal profiles", { signal, key: "directory", showHeading: false, load: () => api.get(`/api/public/paralegals?${query}`, { signal }), render(data) {
    if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0 || !Number.isInteger(data.page) || data.page < 1 || !Number.isInteger(data.pages) || data.pages < 0) throw new Error("invalid_directory");
    const cards = node("div", { className: "av2-candidate-grid" });
    let missing = 0;
    data.items.forEach((record) => {
      const id = record.id || record._id;
      const presentation = normalizePresentation(record.presentation, location.origin, { expectedKind: "card", expectedType: "profile", expectedId: id });
      if (!presentation) { missing += 1; return; }
      const profile = projectCandidate(record, id, "public");
      const context = contextQuery();
      const backQuery = new URLSearchParams(query);
      for (const [key, value] of context) backQuery.set(key, value);
      context.set("returnTo", `#/paralegals?${backQuery}`);
      const href = candidateHref(id, context);
      const portrait = link("", href, "av2-candidate-photo");
      portrait.setAttribute("aria-label", `View ${presentation.object.title}’s profile`);
      portrait.append(photo(profile));
      cards.append(node("article", { className: "av2-candidate-card", "data-av2-candidate": id }, [
        node("div", { className: "av2-candidate-identity" }, [portrait, node("div", { className: "av2-candidate-heading" }, [node("h2", {}, [link(presentation.object.title, href), ...availabilityDot(profile)]), node("p", { className: "av2-candidate-location", text: displayState(presentation.details.find((item) => item.label === "Location")?.value) || "" })])]),
        node("p", { className: "av2-candidate-practice", text: presentation.details.find((item) => item.label === "Practice areas")?.value || "" }),
        ...(presentation.summary && displayState(presentation.summary).trim() !== displayState(presentation.details.find(item=>item.label === "Location")?.value).trim() ? [node("p", {className:"av2-preserve-text av2-candidate-bio",text:displayState(presentation.summary)})] : []),
        node("p", { className: "av2-candidate-experience", text: experience(profile.yearsExperience) }),
      ].filter(element => element.tagName === "DIV" || element.textContent.trim())));
    });
    const pagination = node("nav", { className: "av2-actions", "aria-label": "Profile pages" });
    const href = (page) => { const next = new URLSearchParams(query); next.set("page", page); for (const [key, value] of contextQuery()) next.set(key, value); return `#/paralegals?${next}`; };
    if (data.page > 1) pagination.append(node("a", {href:href(data.page - 1), "aria-label":"Previous profile page",className:"av2-text-link",text:"←"}));
    if (data.page < data.pages) pagination.append(node("a", {href:href(data.page + 1), "aria-label":"Next profile page",className:"av2-text-link",text:"→"}));
    const count = node("p", { className: "av2-muted", text: data.total ? `${data.total} ${data.total === 1 ? "result" : "results"}` : "No paralegals match your filters. Try changing your search or filters." });
    pagination.prepend(count);
    const elements = [cards, pagination];
    if (missing || (data.total > 0 && !data.items.length)) elements.splice(1, 0, node("p", { className: "av2-notice", text: "Some profiles are unavailable on this page. Refresh or choose another page." }));
    return elements;
  } });
  view.append(results); view.readiness = results.readiness;
  return view;
}

export function createCandidate(route, { api, signal, ownerId, privateState }) {
  const view = page("Paralegal profile");
  view.classList.add("av2-profile-resume");
  const back = safeCandidateReturn(route.query.get("returnTo")) || (route.query.get("caseId") && /^[a-f0-9]{24}$/i.test(route.query.get("caseId")) ? `#/matters/${route.query.get("caseId")}/applications` : "#/paralegals");
  const backLabel = back.startsWith("#/paralegals") ? "Back to results" : /\/invitations(?:\?|$)/.test(back) ? "Back to invitations" : /\/applications(?:\?|$)/.test(back) ? "Back to applications" : /^#\/matters(?:\?|$)/.test(back) ? "Back to Matters" : "Back to Matter";
  const backLink = link(`← ${backLabel}`, back, "av2-profile-back");
  const header = document.querySelector('[data-av2-persistent="header"]');
  if (header && !signal.aborted) {
    header.querySelector(".av2-nav-toggle")?.after(backLink);
    view.firstChild.remove();
    signal.addEventListener("abort", () => backLink.remove(), { once: true });
  } else {
    view.firstChild.classList.add("av2-profile-pagebar");
    view.firstChild.replaceChildren(backLink);
  }
  const profileRegion = region("Candidate profile", { signal, key: "candidate-profile", showHeading: false, async load() {
    try { return projectCandidate(await api.get(`/api/paralegals/${route.candidateId}`, { signal }), route.candidateId, "authenticated"); }
    catch (error) {
      // Match the legacy 404 fallback only. Never bypass a blocked/403 profile.
      if (error.status !== 404) throw error;
      return projectCandidate(await api.get(`/api/public/paralegals/${route.candidateId}`, { signal }), route.candidateId, "public");
    }
  }, render(profile) {
    const actions = node("div", { className: "av2-profile-actions" });
    if (profile.tier !== "public") {
      const invitation = createInvitationActions(route.candidateId, { api, signal, ownerId, privateState, caseId: route.query.get("caseId") || "" });
      const disclosure = node("details", { className: "av2-profile-invite" }, [node("summary", { text: "Invite to a Matter" }), invitation]);
      actions.append(disclosure);
    }
    actions.prepend(createSaveParalegal(route.candidateId, { api, signal, ownerId, iconOnly: true }));
    let documents = null;
    if (profile.tier !== "public") {
      documents = node("section", { className: "av2-profile-section av2-profile-documents", "aria-label": "Profile documents" });
      for (const document of profile.documents || []) {
        const notice = node("p", { role: "status" });
        const result = node("span");
        const label = document.label.toLowerCase().replace(/resume/g, "résumé");
        const open = button(`View ${label}`, async () => {
          if (open.disabled || signal.aborted) return;
          // Open during the click so browsers do not block the asynchronous navigation.
          const preview = window.open("about:blank", "_blank");
          if (preview) preview.opener = null;
          const closePreview = () => { if (preview && !preview.closed) preview.close(); };
          signal.addEventListener("abort", closePreview, { once: true });
          open.disabled = true; result.replaceChildren(); notice.textContent = "Opening document…";
          try {
            const payload = await api.get(`/api/uploads/signed-get?${new URLSearchParams({ key: document.key })}`, { signal });
            const href = safeSignedUrl(payload?.url, location.origin);
            if (!href) throw new Error("invalid_document");
            if (signal.aborted) return;
            if (preview && !preview.closed) {
              preview.location.replace(href);
              notice.textContent = "";
            } else {
              result.replaceChildren(node("a", { href, target: "_blank", rel: "noopener noreferrer", className: "av2-text-link", text: `View ${label}` }));
              notice.textContent = "Select the link to open your document.";
            }
          } catch (error) {
            closePreview();
            if (!signal.aborted) notice.textContent = [403, 404].includes(error.status) ? "This document is no longer available to your account." : "The document couldn’t be opened. Please try again.";
          } finally {
            signal.removeEventListener("abort", closePreview);
            if (!signal.aborted) open.disabled = false;
          }
        }, "av2-profile-document-link");
        documents.append(node("div", { className: "av2-actions" }, [open, result]), notice);
      }
    }
    return [renderCandidateProfile(profile, { actions, documents, hiring: node("div", { className: "av2-profile-hiring" }, [link("Continue to hiring", legacyCandidateHref(route.candidateId, route.query))]) })];
  } });
  view.append(profileRegion); view.readiness = profileRegion.readiness;
  return view;
}
