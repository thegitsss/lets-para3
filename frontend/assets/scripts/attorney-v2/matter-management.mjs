import { node, page, link, region } from "./dom.mjs";
import { matterReturnHref, withMatterReturn } from "./matter-return.mjs";
import { createMatterModeration } from "./matter-moderation.mjs";
import { createMatterNotes } from "./matter-notes.mjs";

export function createMatterManagement(route, identity, context) {
  const caseId = route.caseId;
  const section = page("Matter notes and history");
  section.classList.add("av2-matter-management");
  const title = node("h2", { className: "av2-management-title" }), titles = new Map();
  title.hidden = true;
  const showTitle = (source, value) => {
    if (context.signal.aborted) return;
    if (value) titles.set(source, value); else titles.delete(source);
    title.textContent = titles.values().next().value || "";
    title.hidden = !title.textContent;
  };
  section.firstChild.append(title);
  section.firstChild.append(node("div", { className: "av2-actions" }, [link("Back to Matters", matterReturnHref(route)), link("Open Matter workspace", withMatterReturn(`#/matters/${caseId}/overview`, route))]));
  const history = region("Status history", {
    key: "matter-history", signal: context.signal,
    load: async () => {
      showTitle("history", null);
      const value = await context.api.get(`/api/cases/${caseId}/status-history`, { signal: context.signal });
      if (value.caseId !== caseId || typeof value.caseTitle !== "string" || !Array.isArray(value.items) || value.items.some((item) => typeof item.label !== "string" || !Number.isFinite(new Date(item.at).getTime()))) throw new Error("invalid_history");
      showTitle("history", value.caseTitle);
      return value;
    },
    render: (value) => [...(value.complete !== true ? [node("p", { className: "av2-notice", text: "Some history could not be loaded. Refresh to try again." })] : []), ...(value.items.length ? [node("ol", { className: "av2-summary-list" }, value.items.map((item) => node("li", {}, [node("strong", { text: item.label }), node("p", { className: "av2-muted", text: new Date(item.at).toLocaleString() })])))] : [node("p", { text: "No status events are recorded." })])],
  });
  const notes = createMatterNotes(caseId, { ...context, ownerId: identity.id, embedded: true, onTitleChange: value => showTitle("notes", value) });
  const moderation = createMatterModeration(caseId, { ...context, route, ownerId: identity.id, embedded: true, onTitleChange: value => showTitle("review", value), openNotes: () => { notes.scrollIntoView({ block: "start" }); notes.querySelector("textarea")?.focus(); }, onRecorded: () => { void notes.refresh(); } });
  section.append(moderation, history, notes); section.readiness = Promise.allSettled([moderation.readiness, history.readiness, notes.readiness]);
  return section;
}
