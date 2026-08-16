import { secureFetch } from "./auth.js";
import { confirmAction } from "./utils/dialogs.js";

function node(value) {
  return typeof value === "string" ? document.querySelector(value) : value || null;
}

function createNameDialog() {
  const dialog = document.createElement("dialog");
  dialog.className = "lpc-saved-view-dialog";
  dialog.innerHTML = `
    <form method="dialog" class="lpc-saved-view-dialog-card">
      <div>
        <p class="lpc-saved-view-eyebrow">Saved view</p>
        <h2>Save this view</h2>
        <p>Keep this combination of view, search, refinements, and sort order on your account.</p>
      </div>
      <label>View name
        <input type="text" maxlength="48" autocomplete="off" required />
      </label>
      <p class="lpc-saved-view-dialog-status" role="alert" aria-live="polite"></p>
      <div class="lpc-saved-view-dialog-actions">
        <button type="button" data-cancel>Cancel</button>
        <button type="submit" class="is-primary" value="save">Save view</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const input = dialog.querySelector("input");
  const status = dialog.querySelector("[role='alert']");
  dialog.querySelector("[data-cancel]")?.addEventListener("click", () => dialog.close("cancel"));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close("cancel");
  });
  return { dialog, input, status };
}

export function mountDashboardSavedViews(config = {}) {
  const scope = String(config.scope || "");
  const picker = node(config.picker);
  const saveButton = node(config.saveButton);
  const deleteButton = node(config.deleteButton);
  const status = node(config.status);
  const getState = typeof config.getState === "function" ? config.getState : () => ({});
  const applyState = typeof config.applyState === "function" ? config.applyState : () => {};
  const builtIns = Array.isArray(config.builtIns) ? config.builtIns : [];
  if (!scope || !picker || !saveButton) return null;

  let savedViews = [];
  let selectedId = "";
  let loading = false;
  const setStatus = (message = "", tone = "") => {
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  };

  function populatePicker(preferred = selectedId) {
    const builtInGroup = document.createElement("optgroup");
    builtInGroup.label = "Built-in views";
    builtIns.forEach((view) => {
      const option = new Option(String(view.name || "View"), `builtin:${view.id}`);
      builtInGroup.append(option);
    });
    const custom = new Option("Custom view", "custom");
    picker.replaceChildren(builtInGroup, custom);
    if (savedViews.length) {
      const group = document.createElement("optgroup");
      group.label = "Your saved views";
      savedViews.forEach((view) => group.append(new Option(view.name, `saved:${view.id}`)));
      picker.append(group);
    }
    const available = [...picker.options].some((option) => option.value === preferred);
    picker.value = available ? preferred : (builtIns[0] ? `builtin:${builtIns[0].id}` : "custom");
    selectedId = picker.value;
    if (deleteButton) deleteButton.hidden = !selectedId.startsWith("saved:");
  }

  async function load() {
    if (loading) return;
    loading = true;
    setStatus("Loading views…");
    try {
      const response = await secureFetch(`/api/account/dashboard-views?scope=${encodeURIComponent(scope)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to load saved views");
      savedViews = Array.isArray(payload.views) ? payload.views : [];
      populatePicker();
      setStatus(savedViews.length ? `${savedViews.length} saved` : "Views sync to your account");
    } catch (error) {
      populatePicker();
      setStatus("Saved views are temporarily unavailable", "error");
    } finally {
      loading = false;
    }
  }

  function select(value, { apply = true } = {}) {
    selectedId = String(value || "custom");
    picker.value = selectedId;
    if (deleteButton) deleteButton.hidden = !selectedId.startsWith("saved:");
    if (!apply || selectedId === "custom") return;
    const view = selectedId.startsWith("builtin:")
      ? builtIns.find((item) => String(item.id) === selectedId.slice(8))
      : savedViews.find((item) => String(item.id) === selectedId.slice(6));
    if (view?.filters) applyState({ ...view.filters }, view);
  }

  async function save(name) {
    const response = await secureFetch("/api/account/dashboard-views", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: { scope, name, filters: getState() },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error || "Unable to save this view");
    savedViews = [...savedViews.filter((view) => view.id !== payload.view.id), payload.view]
      .sort((left, right) => left.name.localeCompare(right.name));
    populatePicker(`saved:${payload.view.id}`);
    setStatus("View saved", "success");
  }

  picker.addEventListener("change", () => select(picker.value));
  saveButton.addEventListener("click", () => {
    const prompt = createNameDialog();
    prompt.dialog.addEventListener("close", () => prompt.dialog.remove(), { once: true });
    prompt.dialog.querySelector("form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = String(prompt.input.value || "").replace(/\s+/g, " ").trim();
      if (!name) {
        prompt.status.textContent = "Enter a name for this view.";
        return;
      }
      const submit = prompt.dialog.querySelector("[type='submit']");
      submit.disabled = true;
      prompt.status.textContent = "Saving…";
      try {
        await save(name);
        prompt.dialog.close("saved");
      } catch (error) {
        prompt.status.textContent = error?.message || "Unable to save this view.";
        submit.disabled = false;
      }
    });
    prompt.dialog.showModal();
    prompt.input.focus();
  });

  deleteButton?.addEventListener("click", async () => {
    if (!selectedId.startsWith("saved:")) return;
    const viewId = selectedId.slice(6);
    const view = savedViews.find((item) => String(item.id) === viewId);
    if (!view) return;
    const confirmed = await confirmAction(`Delete the saved view “${view.name}”?`, {
      title: "Delete saved view?",
      confirmLabel: "Delete view",
      tone: "danger",
    });
    if (!confirmed) return;
    deleteButton.disabled = true;
    try {
      const response = await secureFetch(`/api/account/dashboard-views/${encodeURIComponent(scope)}/${encodeURIComponent(viewId)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to delete this view");
      savedViews = savedViews.filter((item) => String(item.id) !== viewId);
      populatePicker(builtIns[0] ? `builtin:${builtIns[0].id}` : "custom");
      setStatus("View deleted", "success");
    } catch (error) {
      setStatus(error?.message || "Unable to delete this view", "error");
    } finally {
      deleteButton.disabled = false;
    }
  });

  populatePicker();
  void load();
  return {
    load,
    markCustom() { select("custom", { apply: false }); },
    select,
  };
}
