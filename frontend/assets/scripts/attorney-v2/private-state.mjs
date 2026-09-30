import { clearClosureProof } from '../utils/account-closure-state.mjs';

// Confidential drafts stay in this page's memory, never browser storage or URLs.
// Route changes retain them; session protection/account changes erase them.
export function createPrivateState() {
  const workspaceHeaders = new Map();
  const conversations = new Map();
  const workReviews = new Map();
  const completions = new Map();
  const withdrawals = new Map();
  const funding = new Map();
  const disputes = new Map();
  const dateReviews = new Map();
  const fileReviews = new Map();
  const hiring = new Map();
  const paymentSetup = {};
  const account = {};
  const help = {};
  const hiringReturn = {};
  const invitations = new Map();
  const preEngagement = new Map();
  const applicationDecisions = new Map();
  const contextualBlocks = new Map();
  const archives = new Map();
  const moderation = new Map();
  const savedViews = {};
  const weeks = new Map();
  const matterNotes = new Map();
  const drafts = new Map();
  const postings = new Map();
  let task = {};
  return Object.freeze({
    workspaceHeaders,
    conversations,
    workReviews,
    completions,
    withdrawals,
    funding,
    disputes,
    dateReviews,
    fileReviews,
    hiring,
    paymentSetup,
    account,
    help,
    hiringReturn,
    invitations,
    preEngagement,
    applicationDecisions,
    contextualBlocks,
    archives,
    moderation,
    savedViews,
    weeks,
    matterNotes,
    drafts,
    postings,
    get task() { return task; },
    setTask(value) { task = value; },
    hasUnsaved() { return Boolean([...contextualBlocks.values()].some(value => value.pending) || help.controller?.hasDrafts() || [...funding.values()].some(value => value.pending || value.busy || value.dirty) || account.dirty || account.busy || account.uncertain || account.photoSelection || account.photoRemoval || account.closure?.pending || Object.keys(account.preferenceRequests || {}).length || [...withdrawals.values()].some(value => value.pending || value.busy || value.amountText) || [...disputes.values()].some(value => value.opening || Object.values(value.comments || {}).some(Boolean) || value.pending || value.busy) || [...completions.values()].some(value => value.pending || value.busy) || [...dateReviews.values()].some(value => value.draft || value.pending || value.busy) || [...fileReviews.values()].some(value => Object.values(value.drafts || {}).some(Boolean) || value.pending || value.removal?.pending || value.removal?.target && !value.removal?.outcome || value.upload?.file || value.upload?.pending || Object.values(value.replacements || {}).some(replacement => replacement.file || replacement.pending)) || [...workReviews.values()].some(value => value.pending || value.busy) || [...conversations.values()].some(value => value.text || value.pending || value.busy || value.edit) || [...hiring.values()].some(value => value.pending || value.busy) || paymentSetup.pending || paymentSetup.busy || paymentSetup.dirty || hiringReturn.pending || hiringReturn.busy || [...invitations.values()].some(value => value.pending || value.busy) || [...preEngagement.values()].some(value => value.draft?.dirty || value.pending || value.busy) || [...applicationDecisions.values()].some(value => value.pending || value.busy) || [...archives.values()].some(value => value.pending || value.review || value.busy) || [...moderation.values()].some(value => value.pending || value.review || value.busy) || savedViews.draft || savedViews.pending || savedViews.busy || [...matterNotes.values()].some((note) => note.dirty || note.uncertain || note.busy) || [...postings.values()].some((posting) => posting.dirty || posting.uncertain || posting.busy) || [...drafts.values()].some((draft) => ["busy", "uncertain"].includes(draft.publication?.phase)) || task.title || task.notes || task.uncertain || [...weeks.values()].some((week) => week.dirty || week.uncertain) || [...drafts.values()].some((draft) => !draft.deleted && (draft.dirty || (["save", "delete"].includes(draft.action) && (draft.uncertain || draft.busy))))); },
    clear({ preserveHelpDrafts = false, preserveCardSetup = false } = {}) { help.controller?.clearDrafts({ preserveStorage: preserveHelpDrafts }); help.api?.clear(); Object.keys(help).forEach(key => delete help[key]); clearClosureProof(); Object.keys(account).forEach(key => delete account[key]); funding.clear(); withdrawals.clear(); disputes.clear(); completions.clear(); dateReviews.clear(); workspaceHeaders.clear(); fileReviews.clear(); conversations.clear(); workReviews.clear(); hiring.clear(); if (!preserveCardSetup) paymentSetup.clearRecovery?.(); Object.keys(paymentSetup).forEach(key => delete paymentSetup[key]); Object.keys(hiringReturn).forEach(key => delete hiringReturn[key]); invitations.clear(); preEngagement.clear(); applicationDecisions.clear(); contextualBlocks.clear(); archives.clear(); moderation.clear(); Object.keys(savedViews).forEach((key) => delete savedViews[key]); matterNotes.clear(); weeks.clear(); drafts.clear(); postings.clear(); task = {}; },
  });
}

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isFinite(date.getTime()) && dateKey(date) === value ? date : null;
}
export function weekKey(value = new Date()) {
  if (value === null || value === "") return null;
  const date = typeof value === "string" ? calendarDate(value) : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) return null;
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return dateKey(date);
}
export function moveWeek(key, offset) {
  const date = calendarDate(key);
  if (!date) return null;
  date.setDate(date.getDate() + offset * 7);
  return dateKey(date);
}
export function readWeek(payload, expected) {
  if (payload?.weekStart !== expected) throw new Error("week_boundary");
  if (!Array.isArray(payload.notes) || payload.notes.length !== 7 || payload.notes.some((note) => typeof note !== "string" || note.length > 2000)) throw new Error("invalid_notes");
  if (typeof payload.revision !== "string" || !payload.revision || payload.revision.length > 200) throw new Error("invalid_revision");
  return { notes: [...payload.notes], updatedAt: payload.updatedAt || null, revision: payload.revision };
}
export function sameNotes(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === 7 && b.length === 7 && a.every((note, index) => note === b[index]); }
export function readTaskPage(payload) {
  if (!payload || !Array.isArray(payload.items) || !Number.isInteger(payload.total) || payload.total < 0 || !Number.isInteger(payload.page) || payload.page < 1 || !Number.isInteger(payload.pages) || payload.pages < 0) throw new Error("invalid_tasks");
  if (payload.items.some((task) => !/^[a-f0-9]{24}$/i.test(task.id || "") || typeof task.title !== "string" || typeof task.done !== "boolean")) throw new Error("invalid_tasks");
  return payload;
}
