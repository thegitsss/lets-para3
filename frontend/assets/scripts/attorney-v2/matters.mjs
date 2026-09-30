import { node, link, button, page, region } from "./dom.mjs";
import { withMatterReturn } from "./matter-return.mjs";
import { createReader, activityTime } from "./home.mjs";
import { candidateHref } from "./candidate-model.mjs";
import { readMatterInventory } from './matter-inventory-model.mjs';
import { array, count, id, validId, person, bucket, statusLabel, statusKey, amount, timestamp, dates, filtersFromQuery, applicantCount, matterHref, applicationDisagreements } from "./read-model.mjs";

const VIEWS = { active: "Active", draft: "Drafts", archived: "Archived", applications: "Applications" };
const practiceLabel = value => String(value || "").trim().replace(/^\p{L}/u, letter => letter.toLocaleUpperCase());
const hint = (text) => node("p", { className: "av2-muted", text });
const notice = (text) => node("p", { className: "av2-notice", text });
const routeId = (route, key) => String(route.query.get(key) || '').toLowerCase();
const linkedMatterId = route => routeId(route, 'previewCaseId') || routeId(route, 'highlightCase') || ((route.query.has('openApplicants') || route.query.has('openApplicant')) ? routeId(route, 'caseId') : '');
function hrefFor(route, changes) {
  const query = new URLSearchParams(route.query);
  for (const [key, value] of Object.entries(changes)) {
    if (value === "" || value == null) query.delete(key); else query.set(key, String(value));
  }
  return `#/matters${query.size ? `?${query}` : ""}`;
}
function select(label, name, options, value) {
  const control = node("select", { name, id: `av2-${name}` }, options.map(([key, text]) => node("option", { value: key, text })));
  control.value = value;
  return node("label", { for: control.id }, [node("span", { text: label }), control]);
}
function preview(item) {
  const box = node("div", { className: "av2-matter-preview" }, [
    hint(item.details || item.description || item.briefSummary || "No description provided."),
    node("dl", { className: "av2-preview-facts" }, [
      ["Created", timestamp(item.createdAt)],
    ].map(([name, value]) => node("div", {}, [node("dt", { text: name }), node("dd", { text: value })]))),
  ]);
  if (item.tasks?.length) box.append(node("h3", { text: "Matter scope" }), node("ul", {}, item.tasks.map((task) => node("li", { text: typeof task === "string" ? task : task.title || "Untitled task" }))));
  if (item.invites?.length) box.append(node("h3", { text: "Invitations" }), node("ul", {}, item.invites.map((invite) => node("li", { text: `${person(invite.paralegal) || person(invite.paralegalId) || "Invited paralegal"} · ${String(invite.status || "pending").replaceAll("_", " ")}` }))));
  if (item.pausedReason || item.relistRequestedAt || item.relistPending) box.append(notice([
    item.pausedReason === "paralegal_withdrew" ? "The paralegal withdrew from this matter." : item.pausedReason ? `Pause reason: ${item.pausedReason.replaceAll("_", " ")}.` : "",
    item.relistPending ? "Relisting is pending." : item.relistRequestedAt ? "Relisting has been requested." : "",
    item.disputeDeadlineAt ? `Response deadline: ${new Date(item.disputeDeadlineAt).toLocaleString()}.` : "",
  ].filter(Boolean).join(" ")));
  return box;
}
function matterRow(item, { route, apps, summary, disagreement, signal }) {
  const matterId = id(item);
  const destination = href => withMatterReturn(href, route);
  const draft = bucket(item) === "draft";
  const countApplicants = applicantCount(item);
  const record = node("li", { className: "av2-matter-row", "data-av2-matter": matterId });
  if (!item.localDraft && routeId(route, "highlightCase") === matterId) record.classList.add("av2-highlighted");
  const title = node("h3", {}, [link(item.title || "Untitled Matter", destination(matterHref(item)), "av2-matter-title-link")]);
  const badges = node("div", { className: "av2-badges av2-matter-status" }, [node("span", { className: "av2-status", text: statusLabel(item) })]);
  if (["flagged", "resolution_requested"].includes(item.moderationStatus)) badges.append(node("span", { className: "av2-status", text: "Flagged" }));
  const pendingInvites = (item.invites || []).filter((invite) => (invite.status || "pending") === "pending").length;
  if (pendingInvites || item.pendingParalegalId) badges.append(node("span", { className: "av2-status", text: pendingInvites ? `${pendingInvites} pending ${pendingInvites === 1 ? "invitation" : "invitations"}` : "Invitation pending" }));
  const deadline = dates.matterValue(item);
  const meta = [amount(item), deadline ? `Due ${dates.format(deadline)}` : ""].filter(Boolean);
  const main = node("div", { className: "av2-matter-main" }, [title, node("p", { className: "av2-muted av2-matter-meta", text: meta.join(" · "), title: meta.join(" · ") })]);
  const assignment = node("div", { className: "av2-matter-assignment" }, [
    node("span", { className: "av2-list-person", text: person(item.paralegal) || (!draft ? "Unassigned" : "—") }),
  ]);
  record.append(node("div", { className: "av2-row-heading" }, [main, assignment, badges]));
  if (!item.localDraft && !draft) {
    const fileCount = item.filesCount == null ? "File count unavailable" : `${count(item.filesCount)} ${item.filesCount === 1 ? "file" : "files"}`;
    const unread = summary?.get(matterId);
    if (unread > 0) title.append(node('span', {className:'av2-matter-unread', text:`${unread} unread`, 'aria-label':`${unread} unread messages`}));
    record.dataset.recordInfo = `${fileCount} · ${summary ? unread == null ? "No accessible message thread" : `${unread} unread messages` : "Unread count unavailable"}`;
    if (disagreement) record.append(notice("Applicant counts need verification. The matter and application summaries differ; review applicants before taking action."));
  }
  if (!item.localDraft && draft) record.append(node("details", { className: "av2-preview", "aria-label": `Actions for ${item.title || "Untitled Matter"}` }, [node("summary", { text: "Draft actions" }), node("div", { className: "av2-actions" }, [link("Archive and restore", destination(`#/matters/${matterId}/archive`)), link("View retained record", destination(`#/matters/${matterId}/overview`))])]));
  if (!item.localDraft && !draft) record.append(node("details", { className: "av2-preview", "aria-label": `Actions for ${item.title || "Untitled Matter"}` }, [node("summary", { text: "Matter actions" }), node("div", { className: "av2-actions" }, [
    ...(statusKey(item.status) === "open" ? [link("Review or edit posting", destination(`#/matters/new?caseId=${matterId}`))] : []),
    link("Archive and restore", destination(`#/matters/${matterId}/archive`)),
    link("Files for download", destination(`#/matters/${matterId}/files`)),
    link("Review archive download", destination(`#/matters/${matterId}/export`)),
    link("View receipt", destination(`#/matters/${matterId}/receipt`)),
    ...(!(bucket(item) === "applications" || (apps || []).length) ? [link("Review applications", destination(`#/matters/${matterId}/applications`))] : []),
    link("View invited paralegals", destination(`#/matters/${matterId}/invitations`)),
    link(["flagged", "resolution_requested"].includes(item.moderationStatus) ? "Review admin edit request and history" : "Notes and status history", destination(`#/matters/${matterId}/manage`)),
  ])]));
  const heading = record.querySelector('.av2-row-heading');
  const activity = activityTime(item.lastActivityAt);
  activity.className = 'av2-list-activity';
  heading.append(activity);
  const details = node("details", { className: "av2-preview" }, [node("summary", { text: "Preview matter" }), preview(item)]);
  if (!item.localDraft && routeId(route, "previewCaseId") === matterId) details.open = true;
  record.append(details);
  if (bucket(item) === "applications" || (apps || []).length) {
    const applicationDetails = node("details", { className: "av2-preview" }, [node("summary", { text: countApplicants == null ? "Application summary" : `${countApplicants} ${countApplicants === 1 ? "applicant" : "applicants"} on this matter` })]);
    if (routeId(route, "caseId") === matterId && (route.query.has("openApplicants") || route.query.has("openApplicant"))) applicationDetails.open = true;
    applicationDetails.append(apps ? apps.length ? node("ul", { className: "av2-summary-list" }, apps.map((app) => {
      const name = `${person(app.paralegal) || "Paralegal applicant"}${app.starred ? " · Starred" : ""}`;
      const candidateId = id(app.paralegal);
      const context = new URLSearchParams({ caseId: matterId, applicantId: candidateId, applicationId: id(app), returnTo: hrefFor(route, { caseId: matterId, openApplicant: "1" }) });
      return node("li", {}, [/^[a-f0-9]{24}$/i.test(candidateId) ? link(name, candidateHref(candidateId, context)) : hint(name)]);
    })) : hint("No matching applications in the current application summary.") : hint("Application details couldn’t be loaded. Refresh this list to try again."));
    applicationDetails.append(link("Review applicants", destination(`#/matters/${matterId}/applications`)));
    record.append(applicationDetails);
  }
  // Keep secondary destinations in an always-accessible overflow menu.
  const menu = node('details', { className: 'av2-matter-menu' });
  const toggle = node('summary', { text: '⋮', 'aria-label': `Actions for ${item.title || 'Untitled Matter'}` });
  const menuBody = node('div', { className: 'av2-matter-menu-body' });
  const previewToggle = button('Preview matter', () => {
    menu.open = false; details.open = !details.open;
    if (details.open) { details.tabIndex = -1; details.focus({preventScroll:true}); } else toggle.focus();
  });
  menuBody.append(previewToggle);
  const oldActions = record.querySelector('details[aria-label]');
  if (oldActions) { menuBody.append(...oldActions.querySelectorAll('a')); oldActions.remove(); }
  details.classList.add('av2-matter-inline-preview');
  details.querySelector('summary').textContent = 'Close preview';
  details.querySelector('.av2-matter-preview').prepend(hint(`Updated ${timestamp(item.updatedAt || item.createdAt)}`), ...(record.dataset.recordInfo ? [hint(record.dataset.recordInfo)] : []));
  delete record.dataset.recordInfo;
  menu.append(toggle,menuBody);record.querySelector('.av2-row-heading').append(menu);
  toggle.addEventListener('click', event => {
    event.preventDefault();menu.open = !menu.open;
    if (!menu.open) return;
    document.querySelectorAll('.av2-matter-menu[open]').forEach(other => { if(other!==menu) other.open=false; });
    const rect=toggle.getBoundingClientRect();
    menuBody.style.left=`${Math.max(12,rect.right-menuBody.offsetWidth)}px`;
    menuBody.style.top=`${Math.max(12,Math.min(rect.bottom,innerHeight-menuBody.offsetHeight-12))}px`;
  });
  menu.addEventListener('keydown', event => { if(event.key==='Escape'){event.preventDefault();event.stopPropagation();menu.open=false;toggle.focus();} });
  document.addEventListener('click', event => {if(!menu.contains(event.target))menu.open=false;}, {signal});
  // Safari moves focus to the main region on pointer-down on a button. Keep
  // the menu alive through that gesture so the intended click can finish.
  let pointerInMenu = false;
  document.addEventListener('pointerdown', event => { pointerInMenu = menu.contains(event.target); if (!pointerInMenu) menu.open = false; }, {signal});
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { pointerInMenu = false; }, {signal});
  document.addEventListener('focusin', event => {if(!pointerInMenu && !menu.contains(event.target))menu.open=false;}, {signal});
  document.addEventListener('scroll', event => {if(!menuBody.contains(event.target))menu.open=false;}, {capture:true,signal});
  return record;
}

export function createMatters(route, identity, { api, signal }) {
  const read = createReader(api, signal);
  const preferenceKey = `lpc_attorney_matter_filters:${identity.id}`;
  const preferenceFields = ['view','q','matterPractice','matterDeadline','matterSort','archiveStatus'];
  const targeted = Boolean(linkedMatterId(route));
  if (!targeted) {
    try {
      const stored = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
      if (stored && typeof stored === 'object') for (const key of preferenceFields) {
        if (!route.query.has(key) && typeof stored[key] === 'string' && stored[key].length > 0 && stored[key].length <= 200) route.query.set(key, stored[key]);
      }
    } catch { /* Filtering still works when browser storage is unavailable. */ }
  }
  const rememberFilters = () => {
    if (targeted) return;
    const values = Object.fromEntries(preferenceFields.map(key => [key, route.query.get(key) || '']));
    try { localStorage.setItem(preferenceKey, JSON.stringify(values)); } catch { /* Optional persistence. */ }
  };
  rememberFilters();
  route.query.delete("matterUpdated");
  route.key = hrefFor(route, {}).slice(1);
  history.replaceState(history.state, "", `#${route.key}`);
  const filters = filtersFromQuery(route.query);
  const linkedId = linkedMatterId(route);
  const requestFilters = { ...filters, targetId: !route.query.has('page') && validId(linkedId) ? linkedId : '' };
  const section = page("Matters");
  section.classList.add("av2-matters-index");
  const createMatter = link("", "#/matters/new", "av2-matters-create");
  createMatter.setAttribute("aria-label", "Create new");
  createMatter.append(node("span", { className: "av2-create-plus", "aria-hidden": "true", text: "+" }));
  section.querySelector(".av2-view-header").append(createMatter);
  const categories = node("nav", { className: "av2-categories", "aria-label": "Matter categories" }, Object.entries(VIEWS).map(([view, label]) => link(label, hrefFor(route, { view, page: null }), "av2-category")));
  [...categories.children].forEach((entry, index) => { if (Object.keys(VIEWS)[index] === filters.view) entry.setAttribute("aria-current", "page"); });
  const toolbar = node("div", { className: "av2-matters-toolbar" }, [categories]);
  async function applyFilters(changes) {
    const href = hrefFor(route, {...changes,page:null});
    const query = new URLSearchParams(href.split('?')[1]);
    [...route.query.keys()].forEach(key=>route.query.delete(key));
    for (const [key,value] of query) route.query.set(key,value);
    rememberFilters();
    Object.assign(filters,filtersFromQuery(query));
    Object.assign(requestFilters,filters,{targetId:''});
    route.key = href.slice(1);
    history.replaceState(history.state,'',href);
    [...categories.children].forEach((entry,index)=>entry.href=hrefFor(route,{view:Object.keys(VIEWS)[index],page:null}));
    await panel.refresh({background:true});
  }
  const form = filterForm(filters, changes=>void applyFilters(changes), signal);
  const sort = node('select', { className: 'av2-matter-sort', 'aria-label': 'Sort Matters' }, [
    ['recent', 'Last activity · newest'], ['recent_reverse', 'Last activity · oldest'],
    ['alphabetical', 'Title · A–Z'], ['alphabetical_reverse', 'Title · Z–A'],
    ['deadline', 'Deadline · earliest'], ['deadline_reverse', 'Deadline · latest'],
  ].map(([value, text]) => node('option', { value, text })));
  sort.value = filters.sort;
  const sortControl = node('span', { className: 'av2-matter-sort-control', 'data-label': sort.selectedOptions[0].text }, [sort]);
  sort.addEventListener('change', () => {
    sortControl.dataset.label = sort.selectedOptions[0].text;
    void applyFilters({ matterSort: sort.value });
  });
  toolbar.append(node('div', { className: 'av2-matter-controls' }, [form, sortControl]));
  section.append(toolbar);
  const panel = region(({ active: "Active matters", draft: "Draft matters", archived: "Archived matters", applications: "Applications" })[filters.view], {
    key: "matter-list", signal, showHeading: false,
    load: async () => {
      [...categories.children].forEach((entry, index) => { entry.textContent = Object.values(VIEWS)[index]; });
      const keys = ["inventory", "applications", "messageSummary"];
      const values = await Promise.allSettled(keys.map((key) => key === 'inventory' ? api.readMatterInventory(requestFilters, { ownerId: identity.id, signal }) : read(key)));
      // Keep the visible loading footprint when a short result arrives. Shrinking
      // it can clamp the outlet scroll position during a saved-view button press.
      if (!signal.aborted && panel.isConnected && !panel.style.minHeight) {
        panel.style.minHeight = `${Math.ceil(panel.getBoundingClientRect().height)}px`;
      }
      const result = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
      // Validate each source independently so one failed category never empties another.
      const extract = (key, parse) => {
        try { if (result[key].status !== "fulfilled") throw result[key].reason; return parse(result[key].value); }
        catch (error) { result[key] = { status: "rejected", reason: error }; return null; }
      };
      const inventory = extract('inventory', value => readMatterInventory(value, identity.id, requestFilters));
      if (!inventory) throw result.inventory.reason;
      const apps = extract("applications", array);
      const summary = extract("messageSummary", (value) => new Map(array(value.items).map((item) => [String(item.caseId), count(item.unread)])));
      return { result, inventory, apps, summary };
    },
    render: (data) => {
      const { items: displayed, counts, total, pages, page: currentPage, practices } = data.inventory;
      const failures = Object.entries(data.result).filter(([, value]) => value.status === "rejected").map(([key, value]) => ({ key, restricted: value.reason?.kind === "authorization" }));
      [...categories.children].forEach((entry, index) => {
        const view = Object.keys(VIEWS)[index];
        entry.replaceChildren(document.createTextNode(VIEWS[view]), node("span", { className: "av2-category-count", text: String(counts[view]) }));
      });
      const practice = form.elements.matterPractice, selectedPractice = practice.value;
      const choices = [...new Set([...practices, selectedPractice, filters.practice].filter(Boolean))].sort();
      practice.replaceChildren(node('option', { value: '', text: 'All practice areas' }), ...choices.map(value => node('option', { value, text: practiceLabel(value) })));
      practice.value = selectedPractice;
      const output = [];
      if (failures.length) output.push(notice(`${failures.map(({ key }) => ({ applications: "Applications", messageSummary: "Unread messages" })[key]).join(", ")} ${failures.some((value) => value.restricted) ? "could not be accessed" : "could not be loaded"}.`), button("Retry missing information", () => void panel.refresh()));
      if (currentPage > pages) return [...output, notice('This page is no longer available. Your list may have changed.'), link('Go to the last page', hrefFor(route, { page: pages }))];
      const differences = new Set(data.apps ? applicationDisagreements(data.apps, displayed).map(id) : []);
      if (displayed.length) {
        const renderRow = item => matterRow(item, { route, signal, apps: data.apps?.filter((app) => String(app.caseId) === id(item)), summary: data.summary, disagreement: differences.has(id(item)) });
        if (filters.view === "archived") {
          const groups = new Map();
          for (const item of displayed) {
            const label = statusLabel(item);
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push(item);
          }
          const order = ["Completed", "Closed", "Paused"];
          const labels = [...groups.keys()].sort((a, b) => {
            const rank = label => order.includes(label) ? order.indexOf(label) : order.length;
            return rank(a) - rank(b) || a.localeCompare(b);
          });
          if (pages > 1) output.push(hint("Group counts reflect this page."));
          output.push(node("div", { className: "av2-archive-groups" }, labels.map(label => {
            const items = groups.get(label);
            const rows = items.map(item => {
              const row = renderRow(item);
              const badges = row.querySelector(".av2-matter-status");
              badges.firstElementChild?.remove();
              if (badges.children.length) row.querySelector(".av2-matter-main").append(badges);
              else badges.remove();
              return row;
            });
            return node("details", { className: "av2-archive-group", open: "" }, [
              node("summary", {}, [node("span", { text: label }), node("span", { className: "av2-archive-count", text: String(items.length) })]),
              node("div", { className: "av2-matter-columns", "aria-hidden": "true" }, [node("span", { text: "Matter" }), node("span", { text: "Paralegal" }), node("span", { text: "Last activity" }), node("span")]),
              node("ul", { className: "av2-matter-list" }, rows),
            ]);
          })));
        } else output.push(
          node("div", { className: "av2-matter-columns", "aria-hidden": "true" }, [node("span", { text: "Matter" }), node("span", { text: "Paralegal" }), node("span", { text: "Status" }), node("span", { text: "Last activity" }), node("span")]),
          node("ul", { className: "av2-matter-list" }, displayed.map(renderRow)),
        );
      }
      else {
        const filtered = Boolean(filters.search || filters.practice || filters.deadline || filters.updated || filters.archiveStatus !== 'all');
        output.push(hint(filtered ? 'No Matters match these filters.' : {active:'No active Matters.', draft:'No draft Matters.', archived:'No archived Matters.', applications:'No Matters with applications.'}[filters.view]));
        if(filtered) output.push(button('Clear filters',()=>{
          form.elements.q.value='';form.elements.matterPractice.value='';form.elements.matterDeadline.value='';
          if(form.elements.archiveStatus)form.elements.archiveStatus.value='all';
          form.updateFilterFeedback();
          void applyFilters({q:null,matterPractice:null,matterDeadline:null,matterUpdated:null,archiveStatus:null});
        },'av2-text-link'));
      }
      if (linkedId && !displayed.some((item) => !item.localDraft && id(item) === linkedId)) output.push(notice("The linked matter is not on this page. Check other categories, pages, or filters. Its access or status may have changed."));
      if (filters.view === "applications" && data.apps) {
        const unlinked = data.apps.filter((app) => !app.caseId);
        if (unlinked.length) output.push(notice(`${unlinked.length} application ${unlinked.length === 1 ? "record is" : "records are"} not linked to a Matter.`));
        if (data.apps.length) output.push(link("View all Matters with applications", "#/matters?view=applications&q=&matterPractice=&matterDeadline=&archiveStatus=all"));
      }
      if (pages > 1) {
        const arrow = (label, glyph, target, disabled) => {
          const control = disabled
            ? node('button', {type:'button', disabled:'', className:'av2-page-arrow'})
            : link('', hrefFor(route, {page:target}), 'av2-page-arrow');
          control.setAttribute('aria-label', label);
          control.title = label;
          control.append(node('span', {'aria-hidden':'true', text:glyph}));
          return control;
        };
        output.push(node('nav', {className:'av2-matter-pagination', 'aria-label':'Matter pages'}, [
          arrow('Previous page', '←', currentPage - 1, currentPage === 1),
          node('span', {className:'av2-page-range', text:`${(currentPage - 1) * 15 + 1}–${Math.min(currentPage * 15, total)} of ${total} results`, 'aria-live':'polite'}),
          arrow('Next page', '→', currentPage + 1, currentPage === pages),
        ]));
      }
      return output;
    },
  });
  section.append(panel);
  section.readiness = panel.readiness;
  return section;
}

function filterForm(filters, onChange, signal) {
  const form=node('form',{className:'av2-filters','aria-label':'Filter matters'});
  const search=node('input',{type:'search',name:'q',id:'av2-matter-search',maxlength:200,value:filters.search,placeholder:'Search matters…','aria-label':'Search matters'});
  const searchLabel=node('label',{className:'av2-search-filter'},[search]);
  const fields=node('div',{className:'av2-advanced-fields',id:'av2-matter-filter-fields',hidden:true},[
    select('Practice area','matterPractice',[['','All practice areas'],...(filters.practice ? [[filters.practice,practiceLabel(filters.practice)]] : [])],filters.practice),
    select('Deadline','matterDeadline',[['','All deadlines'],['overdue','Overdue'],['7_days','Next 7 days'],['none','No deadline']],filters.deadline),
    ...(filters.view==='archived' ? [select('Archive status','archiveStatus',[['all','All statuses'],['completed','Completed'],['paused','Paused'],['archived','Archived / closed']],filters.archiveStatus)] : []),
  ]);
  fields.setAttribute('role','region');fields.setAttribute('aria-label','Matter filters');
  const closeFilters = (restoreFocus=false) => {
    fields.hidden=true;toggle.setAttribute('aria-expanded','false');
    if(restoreFocus)toggle.focus({preventScroll:true});
  };
  const positionFilters = () => {
    const rect=toggle.getBoundingClientRect();
    fields.style.left=`${Math.max(12,Math.min(rect.right-fields.offsetWidth,innerWidth-fields.offsetWidth-12))}px`;
    fields.style.top=`${Math.max(12,Math.min(rect.bottom+8,innerHeight-fields.offsetHeight-12))}px`;
  };
  const toggle=button('',()=>{
    if(!fields.hidden){closeFilters();return;}
    fields.hidden=false;toggle.setAttribute('aria-expanded','true');positionFilters();
    fields.querySelector('select')?.focus({preventScroll:true});
  },'av2-filter-toggle');
  toggle.setAttribute('aria-label','Filters');toggle.setAttribute('aria-controls',fields.id);toggle.setAttribute('aria-expanded','false');
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M4 7h16M7 12h10M10 17h4');svg.append(path);toggle.append(svg);
  let timer;
  form.updateFilterFeedback=()=>{
    const count=[...fields.querySelectorAll('select')].filter(e=>e.value&&e.value!=='all').length;
    const label=count ? `Filters · ${count} active` : 'Filters';
    toggle.setAttribute('aria-label',label);toggle.dataset.tooltip=label;
    toggle.classList.toggle('has-filters',count>0);
  };
  const apply=()=>{clearTimeout(timer);onChange(Object.fromEntries(new FormData(form)));form.updateFilterFeedback();};
  form.updateFilterFeedback();
  search.addEventListener('input',event=>{if(!event.isComposing){clearTimeout(timer);timer=setTimeout(apply,350);}});
  search.addEventListener('compositionend',()=>{clearTimeout(timer);timer=setTimeout(apply,350);});
  fields.addEventListener('change',apply);
  form.addEventListener('submit',event=>{event.preventDefault();apply();});
  form.addEventListener('keydown',event=>{if(event.key==='Escape'&&!fields.hidden){event.preventDefault();event.stopPropagation();closeFilters(true);}});
  document.addEventListener('pointerdown',event=>{if(!fields.hidden&&!fields.contains(event.target)&&!toggle.contains(event.target))closeFilters();},{signal});
  document.addEventListener('focusin',event=>{if(!fields.hidden&&!fields.contains(event.target)&&!toggle.contains(event.target))closeFilters();},{signal});
  document.addEventListener('scroll',event=>{if(!fields.hidden&&!fields.contains(event.target))positionFilters();},{capture:true,signal});
  window.addEventListener('resize',()=>{if(!fields.hidden)positionFilters();},{signal});
  signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});
  form.append(searchLabel,toggle,fields);
  return form;
}
