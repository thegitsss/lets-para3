import { confirmAction } from './dialogs.js';

// Guard user dismissal, not successful saves, route teardown or access loss.
export function guardDialogDraft(dialog, {
  buttons = [], hasDraft, isBusy = () => false, onDiscard = () => {},
  title = 'Discard your changes?', message = 'Your changes haven’t been saved.',
  confirmLabel = 'Discard changes', focusOnKeep = null,
}) {
  let confirming = false;
  async function requestClose() {
    if (confirming || isBusy() || !dialog.open) return;
    if (!hasDraft()) { dialog.close(); return; }
    confirming = true;
    try {
      const discard = await confirmAction(message, {
        title, confirmLabel, cancelLabel: 'Keep writing', tone: 'danger',
      });
      if (!dialog.isConnected || !dialog.open || isBusy()) return;
      if (discard) { onDiscard(); dialog.close(); }
      else focusOnKeep?.focus({ preventScroll: true });
    } finally { confirming = false; }
  }
  dialog.addEventListener('cancel', event => {
    event.preventDefault(); event.stopImmediatePropagation(); void requestClose();
  }, true);
  dialog.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (target && buttons.includes(target)) {
      event.preventDefault(); event.stopImmediatePropagation(); void requestClose();
    } else if (event.target === dialog) {
      // Padding is part of the card; only the backdrop dismisses it.
      event.preventDefault(); event.stopImmediatePropagation();
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) void requestClose();
    }
  }, true);
  return requestClose;
}
