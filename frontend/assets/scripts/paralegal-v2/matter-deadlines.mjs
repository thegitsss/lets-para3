import { LpcApiError } from "./api-client.mjs";
import { readDates, readDateOperation, validDate } from "../attorney-v2/dates-model.mjs";

const POLL_INTERVAL_MS = 15_000;

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => {
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function eventId(event) {
  return String(event?.id || event?._id || "");
}

function dateOnly(value) {
  if (!value) return "";
  const direct = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function dateLabel(value, fallback = "No date listed") {
  const date = dateOnly(value);
  if (!date) return fallback;
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function eventsFrom(result) {
  const items = Array.isArray(result?.items) ? result.items : [];
  return result?.selectedEvent && !items.some(item => item.id === result.selectedEvent.id) ? [result.selectedEvent, ...items] : items;
}

export async function readMatterDeadlineEvents(api, matterId, ownerId, { signal, eventId: selectedId = "", cursor = "", requestId = "" } = {}) {
  const query = new URLSearchParams({ expectedOwnerId: ownerId });
  for (const [key, value] of Object.entries({ eventId: selectedId, cursor, requestId })) if (value) query.set(key, value);
  const result = readDates(await api.get(`/api/events/paralegal/matters/${encodeURIComponent(matterId)}/review?${query}`, { signal }), matterId, ownerId);
  if (eventsFrom(result).some(item => item.type !== "deadline") || selectedId && result.selection === "found" && result.selectedEvent.id !== selectedId) throw new Error("The reminder list could not be verified.");
  return result;
}

function eventPayload(state, title, date) {
  const start = `${date}T12:00:00.000Z`;
  if (state.editingEntry) {
    return {
      ...(title !== state.editingEntry.title ? { title } : {}),
      ...(date !== dateOnly(state.editingEntry.start) ? { start, end: start, isAllDay: true } : {}),
    };
  }
  return {
    title,
    start,
    end: start,
    type: "deadline",
    isAllDay: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

function setStatus(state, message, kind = "") {
  const status = state.panel.querySelector("[data-v2-deadline-status]");
  if (!status) return;
  status.textContent = String(message || "");
  if (kind) status.dataset.kind = kind;
  else delete status.dataset.kind;
}

function setBusy(state, busy) {
  state.busy = busy;
  const form = state.panel.querySelector("[data-v2-deadline-form]");
  if (form) form.setAttribute("aria-busy", String(busy));
  state.panel.querySelectorAll("[data-v2-deadline-form] button, [data-v2-deadline-form] input, [data-v2-deadline-content] button").forEach((control) => {
    control.disabled = busy || state.reading || Boolean(state.pending) || state.result?.unavailable || !state.writable && !control.hasAttribute("data-v2-deadline-more");
  });
  const submit = form?.querySelector("button[type='submit']");
  if (submit) submit.textContent = busy ? "Saving…" : state.editingId ? "Save changes" : "Add reminder";
}

function resetForm(state, { focus = false } = {}) {
  state.editingId = "";
  state.editingEntry = null;
  const form = state.panel.querySelector("[data-v2-deadline-form]");
  form?.reset();
  const submit = form?.querySelector("button[type='submit']");
  if (submit) submit.textContent = "Add reminder";
  const cancel = form?.querySelector("[data-v2-deadline-cancel]");
  if (cancel) cancel.hidden = true;
  const legend = form?.querySelector("[data-v2-deadline-form-title]");
  if (legend) legend.hidden = true;
  if (focus) form?.querySelector("[name='title']")?.focus();
  state.onDraftChange?.();
}

function editEvent(state, id) {
  const event = eventsFrom(state.result).find((item) => eventId(item) === id);
  if (!event || !state.writable || state.busy || state.pending) return;
  const form = state.panel.querySelector("[data-v2-deadline-form]");
  state.confirmingId = "";
  state.editingId = id;
  state.editingEntry = event;
  form.querySelector("[name='title']").value = String(event.title || "");
  form.querySelector("[name='date']").value = dateOnly(event.start);
  form.querySelector("button[type='submit']").textContent = "Save changes";
  form.querySelector("[data-v2-deadline-cancel]").hidden = false;
  const legend = form.querySelector("[data-v2-deadline-form-title]");
  legend.textContent = "Edit reminder";
  legend.hidden = false;
  setStatus(state, "");
  form.querySelector("[name='title']").focus();
  state.onDraftChange?.();
}

function renderEvents(state) {
  const content = state.panel.querySelector("[data-v2-deadline-content]");
  const count = state.panel.querySelector("[data-v2-deadline-count]");
  if (!content) return;
  const focused = document.activeElement;
  const focusedId = focused?.closest?.("[data-event-id]")?.dataset.eventId;
  const focusedAction = focused?.tagName === "BUTTON" ? focused.textContent : "";
  const focusedMore = focused?.hasAttribute?.("data-v2-deadline-more");
  if (state.result?.unavailable) {
    if (count) count.textContent = "";
    content.replaceChildren();
    setStatus(state, state.result.message || "Private reminders could not be loaded.", "error");
    return;
  }

  const events = eventsFrom(state.result);
  if (count) count.textContent = state.result?.nextCursor ? `${events.length} of ${state.result.total} shown` : state.result?.total ? `${state.result.total} reminder${state.result.total === 1 ? "" : "s"}` : "";
  if (!events.length) {
    content.replaceChildren(node("p", { className: "v2-matter-empty", text: "You have no private reminders for this matter." }));
    return;
  }

  content.replaceChildren(node("ol", { className: "v2-matter-deadline-list" }, events.map((event) => {
    const id = eventId(event);
    const highlighted = Boolean(id && id === state.highlightedEventId);
    const confirming = Boolean(id && id === state.confirmingId);
    return node("li", {
      className: highlighted ? "is-highlighted" : "",
      ...(id ? { "data-event-id": id } : {}),
      tabindex: "-1",
    }, [
      node("div", { className: "v2-matter-deadline-date" }, [
        node("time", { datetime: dateOnly(event.start), text: dateLabel(event.start) }),
      ]),
      node("strong", { text: event.title || "Personal reminder" }),
      state.writable ? node("div", { className: `v2-matter-deadline-actions${confirming ? " is-confirming" : ""}` }, confirming ? [
        node("button", { type: "button", "data-v2-deadline-delete-cancel": id, text: "Cancel" }),
        node("button", { type: "button", "data-v2-deadline-delete-confirm": id, text: "Delete reminder" }),
      ] : [
        node("button", { type: "button", "data-v2-deadline-edit": id, text: "Edit" }),
        node("button", { type: "button", "data-v2-deadline-delete": id, text: "Delete" }),
      ]) : null,
    ]);
  })));
  if (state.result.nextCursor) content.append(node("button", { type: "button", "data-v2-deadline-more": "", text: "Show more reminders" }));
  setBusy(state, state.busy);
  if (focusedId && !focused.isConnected) {
    const row = content.querySelector(`[data-event-id="${CSS.escape(focusedId)}"]`);
    const control = [...(row?.querySelectorAll("button") || [])].find(button => button.textContent === focusedAction);
    (control || row)?.focus({ preventScroll: true });
  } else if (focusedMore && !focused.isConnected) {
    (content.querySelector("[data-v2-deadline-more]") || content.querySelector("li:last-child"))?.focus({ preventScroll: true });
  }
}

export function createMatterDeadlinesController({
  api,
  getIdentity,
  onSessionLost,
  onAccessLost,
  onChanged,
  onMatterChanged,
} = {}) {
  const panelStates = new WeakMap();
  let current = null;
  let generation = 0;
  let refreshController = null;
  let actionController = null;
  let pollTimer = null;
  let refreshTimer = null;
  let channel = null;
  let globalChannel = null;
  const drafts = new Map();
  let draftOwner = "";

  function remember(state) {
    const form = state.panel.querySelector("[data-v2-deadline-form]");
    const title = form?.elements?.title?.value || "", date = form?.elements?.date?.value || "";
    if (title || date || state.pending || state.editingEntry) drafts.set(state.matterId, { ownerId: state.ownerId, title, date, editingEntry: state.editingEntry, pending: state.pending });
    else drafts.delete(state.matterId);
  }

  function isCurrentState(state) {
    const identity = getIdentity?.();
    return state === current && (!getIdentity || String(identity?.id || identity?._id || "") === state.ownerId);
  }

  function stopSync() {
    if (pollTimer) window.clearInterval(pollTimer);
    if (refreshTimer) window.clearTimeout(refreshTimer);
    pollTimer = null;
    refreshTimer = null;
    channel?.close?.();
    channel = null;
    globalChannel?.close?.();
    globalChannel = null;
  }

  function leave() {
    if (current) remember(current);
    generation += 1;
    refreshController?.abort();
    actionController?.abort();
    refreshController = null;
    actionController = null;
    stopSync();
    current = null;
  }

  function lockPanel(state, message) {
    drafts.delete(state.matterId);
    state.pending = null;
    state.recovery = null;
    state.editingId = "";
    state.editingEntry = null;
    state.writable = false;
    state.locked = true;
    state.result = { unavailable: true, message: message || "Deadline access is no longer available for this matter." };
    state.panel.querySelector("[data-v2-deadline-form]")?.remove();
    state.panel.querySelector("[data-v2-deadline-recovery]")?.replaceChildren();
    renderEvents(state);
    setStatus(state, state.result.message, "error");
  }

  function handleAccessError(state, error, { matterResource = true } = {}) {
    if (error instanceof LpcApiError && error.status === 401) {
      onSessionLost?.();
      return true;
    }
    if (error instanceof LpcApiError && error.status === 403) {
      lockPanel(state, error.message);
      stopSync();
      onAccessLost?.(state.matterId);
      onMatterChanged?.();
      return true;
    }
    if (matterResource && error instanceof LpcApiError && error.status === 404) {
      lockPanel(state, error.message);
      stopSync();
      onAccessLost?.(state.matterId);
      onMatterChanged?.();
      return true;
    }
    return false;
  }

  async function refresh(state, { announce = false, more = false } = {}) {
    if (!isCurrentState(state) || state.reading) return false;
    const requestGeneration = generation;
    refreshController?.abort();
    refreshController = new AbortController();
    state.reading = true;
    setBusy(state, state.busy);
    if (announce) setStatus(state, "Updating reminders…");
    try {
      const previous = state.result?.items || [], seen = new Set();
      let result = await readMatterDeadlineEvents(api, state.matterId, state.ownerId, { signal: refreshController.signal, eventId: state.highlightedEventId, cursor: more ? state.result?.nextCursor : "" });
      if (more && (result.revision !== state.result.revision || result.total !== state.result.total)) throw new Error("The reminder list changed. Check it again.");
      const items = more ? [...previous, ...result.items] : [...result.items];
      while (!more && items.length < previous.length && result.nextCursor) {
        if (seen.has(result.nextCursor)) throw new Error("The reminder list could not be verified.");
        seen.add(result.nextCursor);
        const next = await readMatterDeadlineEvents(api, state.matterId, state.ownerId, { signal: refreshController.signal, eventId: state.highlightedEventId, cursor: result.nextCursor });
        if (next.revision !== result.revision || next.total !== result.total) throw new Error("The reminder list changed. Check it again.");
        items.push(...next.items); result = next;
      }
      if (!isCurrentState(state) || requestGeneration !== generation) return false;
      if (new Set(items.map(item => item.id)).size !== items.length || items.length > result.total || !result.nextCursor && items.length !== result.total) throw new Error("The reminder list changed. Check it again.");
      state.result = { ...result, items };
      renderEvents(state);
      if (announce) setStatus(state, "");
      onChanged?.({ reason: "refresh", matterId: state.matterId });
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrentState(state) || requestGeneration !== generation) return false;
      if (!handleAccessError(state, error)) {
        state.result = { unavailable: true, message: "The reminder list could not be updated. Check it again." };
        renderEvents(state);
        setStatus(state, state.result.message, "error");
      }
      return false;
    } finally {
      state.reading = false;
      if (isCurrentState(state)) { setBusy(state, state.busy); renderRecovery(state); }
    }
  }

  function scheduleRefresh() {
    if (!current || refreshTimer || current.busy || current.pending || current.reading || drafts.has(current.matterId) || current.confirmingId) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void refresh(current);
    }, 100);
  }

  function publishSync(state) {
    try { channel?.postMessage({ matterId: state.matterId, at: Date.now() }); } catch {}
    try { globalChannel?.postMessage({ matterId: state.matterId, at: Date.now() }); } catch {}
  }

  function renderRecovery(state) {
    const recovery = state.panel.querySelector("[data-v2-deadline-recovery]");
    if (!recovery) return;
    recovery.replaceChildren();
    const check = node("button", { type: "button", text: state.pending ? "Check saved action" : "Check reminders", disabled: state.busy || state.reading });
    check.addEventListener("click", () => void (state.pending ? checkPending(state) : refresh(state, { announce: true })));
    if (!state.pending) {
      if (state.result?.unavailable && !state.locked) recovery.append(check);
      return;
    }
    recovery.append(check);
    if (!state.recovery) return;
    const selected = state.recovery.selectedEvent;
    if (state.pending.action !== "create" && !selected) {
      recovery.append(node("p", { text: "That reminder is no longer available." }));
      const close = node("button", { type: "button", text: "Return to reminders", disabled: state.busy || state.reading });
      close.addEventListener("click", () => { state.pending = null; state.recovery = null; resetForm(state); renderRecovery(state); void refresh(state); });
      recovery.append(close);
      return;
    }
    if (selected) recovery.append(node("p", { text: `Current reminder: ${selected.title} · ${dateLabel(selected.start)}` }));
    const retry = node("button", { type: "button", text: state.pending.action === "delete" ? "Delete this version" : "Retry these changes", disabled: state.busy || state.reading });
    retry.addEventListener("click", () => {
      if (!state.recovery || state.busy || state.reading) return;
      state.pending.reviewedMatterRevision = state.recovery.revision;
      if (selected) state.pending.reviewedRevision = selected.revision;
      state.recovery = null;
      void perform(state);
    });
    recovery.append(retry);
  }

  async function acceptOperation(state, value) {
    const operation = readDateOperation(value, state.matterId), pending = state.pending;
    if (!pending || operation.status !== "recorded" || operation.action !== pending.action || pending.eventId && operation.eventId !== pending.eventId || operation.event && operation.event.type !== "deadline") throw new Error("The reminder action could not be confirmed.");
    state.pending = null; state.recovery = null; state.confirmingId = "";
    state.highlightedEventId = operation.event?.id || "";
    resetForm(state);
    const refreshed = await refresh(state);
    if (!isCurrentState(state) || !state.writable) return;
    const message = operation.changedSinceSave ? "The action was recorded. The reminder has since changed or been removed." : operation.action === "create" ? "Reminder added." : operation.action === "delete" ? "Reminder deleted." : "Reminder updated.";
    setStatus(state, refreshed ? message : `${message} The list could not be updated.`, refreshed ? "success" : "error");
    publishSync(state);
    onChanged?.({ reason: operation.action, matterId: state.matterId });
  }

  async function perform(state) {
    if (!isCurrentState(state) || state.busy || state.reading || !state.pending || !state.writable) return;
    actionController?.abort(); actionController = new AbortController();
    const controller = actionController;
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    state.recovery = null;
    remember(state); setBusy(state, true); renderRecovery(state);
    setStatus(state, state.pending.action === "delete" ? "Deleting reminder…" : "Saving reminder…");
    try {
      const response = await api.post(`/api/events/paralegal/matters/${encodeURIComponent(state.matterId)}/reviewed-action`, { ...state.pending, expectedOwnerId: state.ownerId }, { signal: controller.signal });
      if (!isCurrentState(state) || controller.signal.aborted) return;
      await acceptOperation(state, response?.operation);
    } catch (error) {
      if (!isCurrentState(state)) return;
      if (!handleAccessError(state, error)) {
        if ([400, 422].includes(error?.status)) {
          state.pending = null;
          setStatus(state, "The reminder was not saved. Check the name and date.", "error");
        } else {
          setStatus(state, "We couldn’t confirm this change. Check its status before trying again.", "error");
        }
      }
    } finally {
      window.clearTimeout(timer);
      if (isCurrentState(state)) { remember(state); setBusy(state, false); renderRecovery(state); }
    }
  }

  async function checkPending(state) {
    if (!isCurrentState(state) || state.busy || state.reading || !state.pending) return;
    state.reading = true; setBusy(state, false); renderRecovery(state);
    refreshController?.abort(); refreshController = new AbortController();
    try {
      const result = await readMatterDeadlineEvents(api, state.matterId, state.ownerId, { signal: refreshController.signal, requestId: state.pending.requestId, eventId: state.pending.eventId || "" });
      if (!isCurrentState(state)) return;
      if (result.operation?.status === "recorded") {
        state.reading = false;
        await acceptOperation(state, result.operation);
      } else if (result.operation?.status === "missing") {
        state.recovery = result;
        setStatus(state, state.pending.action !== "create" && !result.selectedEvent ? "We couldn’t confirm this change." : "We couldn’t confirm this change. Review the details before retrying.");
      } else throw new Error("The saved action could not be checked.");
    } catch (error) {
      if (isCurrentState(state) && !handleAccessError(state, error)) setStatus(state, "The saved action could not be checked. Try checking again.", "error");
    } finally {
      state.reading = false;
      if (isCurrentState(state)) { remember(state); setBusy(state, false); renderRecovery(state); }
    }
  }

  async function save(state) {
    if (state.busy || state !== current || !state.writable || state.reading || state.pending || state.result?.unavailable) return;
    const form = state.panel.querySelector("[data-v2-deadline-form]");
    const title = String(form?.elements?.title?.value || "").trim(), date = form?.elements?.date?.value || "";
    if (!title || !validDate(date)) { setStatus(state, "Add a reminder name and valid date.", "error"); (!title ? form.elements.title : form.elements.date).focus(); return; }
    const values = eventPayload(state, title, date);
    if (!Object.keys(values).length) { setStatus(state, "No changes to save."); return; }
    state.pending = { action: state.editingEntry ? "update" : "create", values, requestId: crypto.randomUUID(), reviewedMatterRevision: state.result.revision, ...(state.editingEntry ? { eventId: state.editingEntry.id, reviewedRevision: state.editingEntry.revision } : {}) };
    await perform(state);
  }

  async function remove(state, id) {
    if (!id || !isCurrentState(state) || state.busy || state.reading || state.pending || !state.writable || state.result?.unavailable) return;
    const event = eventsFrom(state.result).find(item => item.id === id);
    if (!event) { setStatus(state, "That reminder is no longer available.", "error"); await refresh(state); return; }
    state.pending = { action: "delete", values: {}, eventId: id, requestId: crypto.randomUUID(), reviewedMatterRevision: state.result.revision, reviewedRevision: event.revision };
    await perform(state);
  }

  function panel({ matterId, ownerId, matterDeadline, eventsResult, highlightedEventId = "", writable = false } = {}) {
    if (draftOwner !== ownerId) { drafts.clear(); draftOwner = ownerId; }
    const retained = drafts.get(String(matterId || ""));
    const content = node("div", { className: "v2-matter-deadline-content", "data-v2-deadline-content": "" });
    const status = node("p", {
      className: "v2-matter-deadline-status",
      "data-v2-deadline-status": "",
      role: "status",
      "aria-live": "polite",
    });
    const form = writable ? node("form", {
      className: "v2-matter-deadline-form",
      "data-v2-deadline-form": "",
      "aria-label": "Add or edit a private matter reminder",
    }, [
      node("strong", { "data-v2-deadline-form-title": "", text: "Edit reminder", hidden: "" }),
      node("div", { className: "v2-matter-deadline-fields" }, [
        node("label", {}, [node("span", { text: "Reminder" }), node("input", { name: "title", type: "text", maxlength: "500", required: "", autocomplete: "off" })]),
        node("label", {}, [node("span", { text: "Date" }), node("input", { name: "date", type: "date", required: "" })]),
      ]),
      node("div", { className: "v2-matter-deadline-form-actions" }, [
        node("button", { type: "submit", text: "Add reminder" }),
        node("button", { type: "button", "data-v2-deadline-cancel": "", hidden: "", text: "Cancel" }),
      ]),
    ]) : null;
    const section = node("section", {
      className: "v2-matter-panel v2-matter-deadlines",
      "aria-labelledby": "v2-matter-deadlines-title",
      "data-v2-deadline-panel": "",
    }, [
      node("div", { className: "v2-matter-panel-heading" }, [
        node("div", {}, [
          node("h2", { id: "v2-matter-deadlines-title", text: "Deadlines" }),
        ]),
      ]),
      node("div", { className: "v2-matter-shared-deadline" }, [
        node("div", {}, [node("span", { text: "Matter deadline" }), node("strong", { text: dateLabel(matterDeadline, "No matter deadline is set") })]),
      ]),
      node("div", { className: "v2-matter-private-deadlines" }, [
        node("div", { className: "v2-matter-private-deadlines-copy" }, [
          node("strong", { text: "Your private reminders" }),
          node("p", { text: "Reminders don’t change the Matter deadline." }),
          node("p", { "data-v2-deadline-count": "" }),
        ]),
        content,
        form,
        status,
        node("div", { "data-v2-deadline-recovery": "", className: "v2-matter-deadline-recovery" }),
      ]),
    ]);

    const state = {
      panel: section,
      matterId: String(matterId || ""),
      ownerId: String(ownerId || ""),
      highlightedEventId: String(highlightedEventId || ""),
      writable: Boolean(writable),
      result: eventsResult,
      editingId: "",
      editingEntry: retained?.editingEntry || null,
      pending: retained?.pending || null,
      recovery: null,
      reading: false,
      confirmingId: "",
      busy: false,
    };
    state.onDraftChange = () => remember(state);
    if (form && retained) {
      form.elements.title.value = retained.title;
      form.elements.date.value = retained.date;
      if (state.editingEntry) {
        state.editingId = state.editingEntry.id;
        form.querySelector("[data-v2-deadline-form-title]").hidden = false;
        form.querySelector("[data-v2-deadline-cancel]").hidden = false;
      }
    }
    panelStates.set(section, state);
    renderEvents(state);
    setBusy(state, false);
    renderRecovery(state);
    if (state.pending) setStatus(state, "We couldn’t confirm this change. Check its status before trying again.", "error");
    form?.addEventListener("input", () => remember(state));
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      void save(state);
    });
    form?.querySelector("[data-v2-deadline-cancel]")?.addEventListener("click", () => resetForm(state, { focus: true }));
    section.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-v2-deadline-edit]");
      const deletion = event.target.closest("[data-v2-deadline-delete]");
      const deletionCancel = event.target.closest("[data-v2-deadline-delete-cancel]");
      const deletionConfirm = event.target.closest("[data-v2-deadline-delete-confirm]");
      if (event.target.closest("[data-v2-deadline-more]")) void refresh(state, { more: true });
      if (edit) editEvent(state, edit.dataset.v2DeadlineEdit);
      if (deletion && !state.pending && !state.busy && !state.reading) {
        state.confirmingId = deletion.dataset.v2DeadlineDelete;
        renderEvents(state);
        state.panel.querySelector(`[data-v2-deadline-delete-confirm="${CSS.escape(state.confirmingId)}"]`)?.focus();
      }
      if (deletionCancel) {
        const id = deletionCancel.dataset.v2DeadlineDeleteCancel;
        state.confirmingId = "";
        renderEvents(state);
        state.panel.querySelector(`[data-v2-deadline-delete="${CSS.escape(id)}"]`)?.focus();
      }
      if (deletionConfirm) void remove(state, deletionConfirm.dataset.v2DeadlineDeleteConfirm);
    });
    return section;
  }

  function afterMount(root) {
    const section = root?.querySelector?.("[data-v2-deadline-panel]");
    const state = section ? panelStates.get(section) : null;
    if (!state) return;
    current = state;
    generation += 1;
    if (typeof BroadcastChannel === "function") {
      try {
        channel = new BroadcastChannel(`lpc-v2-matter-deadlines:${state.matterId}`);
        channel.addEventListener("message", scheduleRefresh);
      } catch {
        channel = null;
      }
      try {
        globalChannel = new BroadcastChannel("lpc-v2-deadlines");
      } catch {
        globalChannel = null;
      }
    }
    pollTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") scheduleRefresh();
    }, POLL_INTERVAL_MS);
    const highlighted = state.highlightedEventId
      ? state.panel.querySelector(`[data-event-id="${CSS.escape(state.highlightedEventId)}"]`)
      : null;
    highlighted?.focus();
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible" && current) scheduleRefresh();
  }

  function handleAuthoritativeRefresh(event) {
    const types = Array.isArray(event?.detail?.signalTypes) ? event.detail.signalTypes : [];
    if (types.some((type) => type.startsWith("calendar_event_") || ["deadline_refresh", "event_refresh", "case_refresh"].includes(type))) {
      scheduleRefresh();
    }
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("online", scheduleRefresh);
  window.addEventListener("lpc:v2-authoritative-refresh", handleAuthoritativeRefresh);

  return Object.freeze({
    panel, afterMount, leave,
    refresh: () => current ? refresh(current, { announce: true }) : Promise.resolve(),
    hasDrafts() { if (current) remember(current); return drafts.size > 0; },
    clearDrafts() {
      drafts.clear();
      if (current) { current.pending = null; current.recovery = null; resetForm(current); setBusy(current, false); renderRecovery(current); }
    },
  });
}
