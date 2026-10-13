const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  'details > summary:first-of-type',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const dialogFocusState = new WeakMap();

function isFocusableVisible(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden || element.closest("[hidden], [inert]")) return false;
  const styles = window.getComputedStyle(element);
  return styles.display !== "none" && styles.visibility !== "hidden";
}

function getFocusableElements(root) {
  return Array.from(root.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)).filter(isFocusableVisible);
}

function resolveFocusTarget(root, preferredTarget) {
  if (preferredTarget instanceof HTMLElement && isFocusableVisible(preferredTarget)) return preferredTarget;
  const firstFocusable = getFocusableElements(root)[0];
  if (firstFocusable) return firstFocusable;
  const dialog = root.matches?.('[role="dialog"]') ? root : root.querySelector?.('[role="dialog"]');
  if (dialog instanceof HTMLElement) {
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
    return dialog;
  }
  if (root instanceof HTMLElement) {
    if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
    return root;
  }
  return null;
}

export function deactivateDialogFocus(root, { restoreFocus = true } = {}) {
  if (!(root instanceof HTMLElement)) return;
  const state = dialogFocusState.get(root);
  if (!state) return;
  document.removeEventListener("keydown", state.handleKeydown, true);
  dialogFocusState.delete(root);
  if (restoreFocus && state.returnFocus?.isConnected && !state.returnFocus.closest?.("[inert]")) {
    state.returnFocus.focus();
  }
}

export function activateDialogFocus(root, { initialFocus = null, returnFocus = null, onEscape = null, deferInitialFocus = true } = {}) {
  if (!(root instanceof HTMLElement)) return;
  deactivateDialogFocus(root, { restoreFocus: false });
  const resolvedReturnFocus =
    returnFocus instanceof HTMLElement
      ? returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

  const handleKeydown = (event) => {
    if (event.key === "Escape" && typeof onEscape === "function") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = getFocusableElements(root);
    if (!focusable.length) {
      event.preventDefault();
      resolveFocusTarget(root, initialFocus)?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!root.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  dialogFocusState.set(root, { handleKeydown, returnFocus: resolvedReturnFocus });
  document.addEventListener("keydown", handleKeydown, true);
  const focusInitial = () => resolveFocusTarget(root, initialFocus)?.focus();
  if (deferInitialFocus) window.requestAnimationFrame(focusInitial);
  else focusInitial();
}
