function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => element.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return element;
}

const TOURS = Object.freeze({
  workspace: Object.freeze({
    field: "paralegalTourCompleted",
    steps: Object.freeze([
      Object.freeze({ title: "Your day starts here", copy: "Check your matters, messages, and upcoming deadlines." }),
      Object.freeze({ title: "Put your experience to work", copy: "Explore open matters and find work that interests you." }),
      Object.freeze({ title: "Keep your work organized", copy: "Find your conversations, documents, and deadlines together." }),
    ]),
  }),
  profile: Object.freeze({
    field: "paralegalProfileTourCompleted",
    steps: Object.freeze([
      Object.freeze({ title: "Introduce yourself", copy: "Show attorneys the experience and skills you bring." }),
      Object.freeze({ title: "Keep your profile current", copy: "Update your details anytime. Changes save automatically." }),
    ]),
  }),
});

function normalizedState(value = {}) {
  return {
    paralegalTourCompleted: value.paralegalTourCompleted === true,
    paralegalProfileTourCompleted: value.paralegalProfileTourCompleted === true,
  };
}

export function createOnboardingController({ api, dialogHost, getIdentity, updateIdentity, showToast, getRoute } = {}) {
  let state = normalizedState();
  let userId = "";
  let dialog = null;
  let loading = null;
  const dismissed = new Set();
  let returnFocus = null;

  function syncIdentity() {
    const identity = getIdentity?.() || {};
    updateIdentity?.({ ...identity, onboarding: { ...(identity.onboarding || {}), ...state } });
  }

  async function markComplete(field) {
    const owner = userId;
    try {
      const result = await api.request("/api/users/me/onboarding", {
        method: "PATCH", body: JSON.stringify({ [field]: true }),
      });
      if (userId !== owner) return false;
      if (result?.onboarding?.[field] !== true) throw new Error("Completion was not confirmed.");
      state = normalizedState(result.onboarding);
      syncIdentity();
      return true;
    } catch { return false; }
  }

  function closeDialog() {
    if (!dialog) return;
    const current = dialog;
    dialog = null;
    if (current.open) current.close();
    current.remove();
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  function openTour(name, { force = false, trigger = null } = {}) {
    const tour = TOURS[name];
    if (!tour || dialog || (!force && (state[tour.field] || dismissed.has(tour.field)))) return false;
    let index = 0, saving = false;
    const error = node("p", { className: "v2-onboarding-error", role: "alert", hidden: true });
    const title = node("h2", { id: "v2-onboarding-title" });
    const copy = node("p", { "data-v2-onboarding-copy": "" });
    const progress = node("p", { className: "v2-onboarding-progress", "aria-live": "polite" });
    const skip = node("button", { className: "v2-matter-dialog-secondary", type: "button", text: "Close tour" });
    const back = node("button", { className: "v2-matter-dialog-secondary", type: "button", text: "Back" });
    const next = node("button", { className: "v2-matter-dialog-primary", type: "button", text: "Next" });
    const currentDialog = node("dialog", {
      className: "v2-matter-dialog v2-onboarding-dialog",
      "aria-labelledby": "v2-onboarding-title",
      "data-v2-onboarding-dialog": name,
    }, [
      node("div", { className: "v2-matter-dialog-body" }, [progress, title, copy, error]),
      node("footer", {}, [skip, node("div", { className: "v2-onboarding-step-actions" }, [back, next])]),
    ]);

    function renderStep() {
      const step = tour.steps[index];
      progress.textContent = `${index + 1} of ${tour.steps.length}`;
      title.textContent = step.title;
      copy.textContent = step.copy;
      back.disabled = saving || index === 0;
      next.disabled = saving;
      skip.disabled = saving;
      next.textContent = saving ? "Saving…" : index === tour.steps.length - 1 ? "Finish tour" : "Next";
    }

    async function finish() {
      if (saving) return;
      saving = true; error.hidden = true; renderStep();
      const success = await markComplete(tour.field);
      if (dialog !== currentDialog) return;
      saving = false; renderStep();
      if (success) { closeDialog(); routeChanged(getRoute?.()); }
      else { error.textContent = "Couldn’t save tour completion. Try again."; error.hidden = false; next.focus(); }
    }

    const dismiss = () => {
      if (saving) return;
      dismissed.add(tour.field);
      closeDialog();
    };
    skip.addEventListener("click", dismiss);
    back.addEventListener("click", () => {
      index = Math.max(0, index - 1);
      renderStep();
      (back.disabled ? next : back).focus();
    });
    next.addEventListener("click", () => {
      if (index < tour.steps.length - 1) {
        index += 1;
        renderStep();
        next.focus();
        return;
      }
      void finish();
    });
    currentDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismiss();
    });
    returnFocus = trigger || document.activeElement;
    dialogHost?.append(currentDialog);
    dialog = currentDialog;
    renderStep();
    currentDialog.showModal();
    next.focus();
    return true;
  }

  function routeChanged(route) {
    if (!userId || dialog || !route) return;
    const forceWorkspace = route.query?.get("tour") === "1";
    if (forceWorkspace || (!state.paralegalTourCompleted && !dismissed.has("paralegalTourCompleted"))) {
      if (forceWorkspace) consumeReplayFlag(route, "tour");
      openTour("workspace", { force: forceWorkspace });
      return;
    }
    const onProfile = route.name === "settings" && String(route.query?.get("tab") || "profile") === "profile";
    const forceProfile = route.query?.get("profilePrompt") === "1";
    if (forceProfile) consumeReplayFlag(route, "profilePrompt");
    if ((onProfile && !state.paralegalProfileTourCompleted && !dismissed.has("paralegalProfileTourCompleted")) || forceProfile) openTour("profile", { force: forceProfile });
  }

  function consumeReplayFlag(route, key) {
    route.query?.delete(key);
    const url = new URL(window.location.href);
    const [path, rawQuery = ""] = url.hash.split("?");
    const query = new URLSearchParams(rawQuery);
    query.delete(key);
    url.hash = `${path}${query.size ? `?${query}` : ""}`;
    window.history.replaceState(window.history.state, "", url);
  }

  async function start(identity) {
    const nextUserId = String(identity?.id || identity?._id || "");
    if (!nextUserId) return;
    if (nextUserId !== userId) {
      closeDialog();
      dismissed.clear();
      userId = nextUserId;
      state = normalizedState(identity?.onboarding || {});
    }
    if (!loading) {
      loading = api.get("/api/users/me/onboarding")
        .then((result) => {
          state = normalizedState(result?.onboarding || state);
          syncIdentity();
        })
        .catch((error) => {
          showToast?.(error?.message || "We couldn’t load your tour progress. Please try again.");
        })
        .finally(() => { loading = null; });
    }
    await loading;
    routeChanged(getRoute?.());
  }

  function stop() {
    closeDialog();
    userId = "";
    state = normalizedState();
  }

  return Object.freeze({ start, stop, routeChanged, replay: trigger => openTour("workspace", { force: true, trigger }) });
}
