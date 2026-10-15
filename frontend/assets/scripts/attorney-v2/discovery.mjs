import { availabilityDot } from "./availability-dot.mjs";
import { createSaveParalegal, createSavedParalegals } from "./saved-paralegals.mjs";
import { compactFilters } from "./presentation.mjs";
import { node, page, link, button, region } from "./dom.mjs";
import { field, select } from "./tasks.mjs";
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
function multipleChoice(label, values, selected) {
  const checked = new Set(selected.split(/[|,]/).filter(Boolean));
  const summary = node("summary", { text: `${label}${checked.size ? ` (${checked.size})` : ""}` });
  const controls = [...new Set([...values, ...checked])].map((value) => {
    const input = node("input", { type: "checkbox", value }); input.checked = checked.has(value);
    input.addEventListener("change", () => { if (input.checked) checked.add(value); else checked.delete(value); summary.textContent = `${label}${checked.size ? ` (${checked.size})` : ""}`; });
    return node("label", {}, [input, node("span", { text: value })]);
  });
  return { element: node("details", { className: "av2-preview" }, [summary, node("div", { className: "av2-multi-options", role: "group", "aria-label": label }, controls)]), value: () => [...checked].join("|") };
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
  for (const [label, href, active] of [['Browse paralegals', listHref(false), !saved], ['Saved paralegals', listHref(true), saved]]) {
    const item = link(label, href); if (active) item.setAttribute('aria-current', 'page'); tabs.append(item);
  }
  view.append(tabs);
  if (matterReturn) view.firstChild.append(link("Back to Matter", matterReturn));
  if (saved) { const list = createSavedParalegals({ api, signal, ownerId, context: contextQuery(), returnTo: listHref(true) }); view.append(list); view.readiness = list.readiness; return view; }
  const query = directoryQuery(route.query);
  const filters = node("form", { className: "av2-card", "aria-label": "Paralegal filters" });
  const search = node("input", { type: "search", maxlength: "200", value: query.get("q") || "" });
  const years = select([["", "Any experience"], ["1", "1+ years"], ["3", "3+ years"], ["5", "5+ years"], ["10", "10+ years"]], query.get("minYears") || "");
  if (query.has("minYears") && !years.value) { years.append(node("option", { value: query.get("minYears"), text: `${query.get("minYears")}+ years` })); years.value = query.get("minYears"); }
  const sort = select([["recent", "Most recent"], ["alpha", "Name A–Z"], ["experience", "Most experienced"]], query.get("sort"));
  const locations = multipleChoice("States", states, query.get("location") || "");
  const practices = multipleChoice("Practice areas", specialties, query.get("practice") || "");
  const clearContext = contextQuery();
  filters.append(field("Search profiles", search), field("Minimum experience", years), field("Sort profiles", sort), locations.element, practices.element, node("button", {type:"submit",hidden:true,text:"Find paralegals"}), link("Clear filters", `#/paralegals${clearContext.size ? `?${clearContext}` : ""}`));
  compactFilters(filters, {placeholder:"Search paralegals…", signal});
  filters.addEventListener("submit", (event) => {
    event.preventDefault(); const next = contextQuery();
    for (const [key, value] of Object.entries({ q: search.value.trim(), minYears: years.value, sort: sort.value, location: locations.value(), practice: practices.value() })) if (value) next.set(key, value);
    location.hash = `#/paralegals?${next}`;
  });
  view.append(filters);
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
      cards.append(node("article", { className: "av2-candidate-card", "data-av2-candidate": id }, [
        node("div", { className: "av2-candidate-identity" }, [photo(profile), node("h2", {}, [link(presentation.object.title, href), ...availabilityDot(profile)])]),
        node("p", { className: "av2-muted", text: displayState(presentation.details.find((item) => item.label === "Location")?.value) || "" }),
        node("p", { text: presentation.details.find((item) => item.label === "Practice areas")?.value || "" }),
        ...(presentation.summary && displayState(presentation.summary).trim() !== displayState(presentation.details.find(item=>item.label === "Location")?.value).trim() ? [node("p", {className:"av2-preserve-text",text:displayState(presentation.summary)})] : []),
        node("p", { text: experience(profile.yearsExperience) }),
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
    const intro = node("header", { className: "av2-profile-intro" }, [photo(profile), node("div", {}, [node("div", { className: "av2-profile-name-row" }, [node("h1", { id: "av2-page-title", text: profile.name }), node("div", { className: "av2-profile-name-actions" }, [...availabilityDot(profile)])]), node("p", { className: "av2-muted", text: [displayState(profile.location || profile.state) || "", experience(profile.yearsExperience)].filter(Boolean).join(" · ") })])]);
    intro.querySelectorAll(":scope > div > p").forEach(element => { if (!element.textContent.trim()) element.remove(); });
    const sections = [];
    const sidebar = node("aside", { className: "av2-profile-sidebar", "aria-label": "Profile details and actions" });
    const actions = node("div", { className: "av2-profile-actions" });
    if (profile.tier !== "public") {
      const invitation = createInvitationActions(route.candidateId, { api, signal, ownerId, privateState, caseId: route.query.get("caseId") || "" });
      const disclosure = node("details", { className: "av2-profile-invite" }, [node("summary", { text: "Invite to a Matter" }), invitation]);
      actions.append(disclosure);
    }
    actions.prepend(createSaveParalegal(route.candidateId, { api, signal, ownerId, iconOnly: true }));
    const paragraph = (heading, value, target = sections) => { if (value) { const section = node("section", { className: "av2-profile-section" }, [node("h2", { text: heading }), node("p", { className: "av2-preserve-text", text: value })]); Array.isArray(target) ? target.push(section) : target.append(section); } };
    paragraph("About", profile.bio || profile.about);
    if (profile.bio && profile.about && profile.about !== profile.bio) paragraph("More about this paralegal", profile.about);
    for (const [heading, values] of [["Practice areas", profile.practiceAreas.length ? profile.practiceAreas : profile.specialties], ["Skills", profile.skills], ["States of experience", profile.stateExperience?.length ? profile.stateExperience : profile.jurisdictions], ["Languages", profile.languages]]) paragraph(heading, values?.join(", "), sidebar);
    for (const [heading, records] of [["Experience", profile.experience], ["Education", profile.education]]) {
      const entries = (records || []).filter(item => Object.values(item).some(Boolean)).map(item => {
        const education = heading === "Education";
        const primary = education ? [item.degree, item.fieldOfStudy].filter(Boolean).join(" · ") : item.title;
        const organization = education ? item.school : [item.company, item.firm].filter((value, index, all) => value && all.indexOf(value) === index).join(" · ");
        const dates = education ? [item.startYear, item.endYear].filter(Boolean).join("–") : [item.startDate, item.endDate].filter(Boolean).join(" – ");
        const details = education ? [item.grade && `Grade: ${item.grade}`, item.activities && `Activities: ${item.activities}`] : [item.years, item.description];
        return node("div", { className: "av2-profile-record" }, [
          ...(primary ? [node("p", { className: "av2-profile-record-title", text: primary })] : []),
          ...(organization ? [node("p", { text: organization })] : []),
          ...(dates ? [node("p", { className: "av2-muted", text: dates })] : []),
          ...details.filter(Boolean).map(text => node("p", { className: "av2-preserve-text av2-muted", text })),
        ]);
      });
      if (entries.length) sections.push(node("section", { className: "av2-profile-section" }, [node("h2", { text: heading }), ...entries]));
    }
    try { const url = new URL(profile.linkedInURL); if (url.protocol === "https:" && !url.username && !url.password && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))) sections.push(node("a", { className: "av2-text-link", href: url.href, target: "_blank", rel: "noopener noreferrer", text: "LinkedIn profile" })); } catch { /* No valid LinkedIn profile. */ }
    if (profile.tier === "public") sections.push(node("p", { className: "av2-notice", text: "Public profile preview. Member documents and additional experience are unavailable for this profile." }));
    else {
      const documents = node("section", { className: "av2-profile-section av2-profile-documents", "aria-label": "Profile documents" });
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
      if (profile.documents?.length) sidebar.append(documents);
    }
    sidebar.append(node("div", { className: "av2-profile-hiring" }, [link("Continue to hiring", legacyCandidateHref(route.candidateId, route.query))]));
    return [intro, node("div", { className: "av2-profile-columns" }, [actions, node("div", { className: "av2-profile-content" }, sections), sidebar])];
  } });
  view.append(profileRegion); view.readiness = profileRegion.readiness;
  return view;
}
