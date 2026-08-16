import { activateDialogFocus, deactivateDialogFocus } from "./dialog-focus.js";

const DIALOG_STYLE_MARKER = "lpc-dialog-styles";
let dialogSequence = 0;
let activeDialog = null;
let dialogQueue = Promise.resolve();

function ensureStyles() {
  if (document.querySelector(`link[data-${DIALOG_STYLE_MARKER}]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("../../styles/dialogs.css", import.meta.url).href;
  link.setAttribute(`data-${DIALOG_STYLE_MARKER}`, "true");
  document.head.append(link);
}

function normalizedText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function createDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  input = null,
}) {
  ensureStyles();
  const sequence = ++dialogSequence;
  const titleId = `lpc-dialog-title-${sequence}`;
  const descriptionId = `lpc-dialog-description-${sequence}`;
  const inputId = `lpc-dialog-input-${sequence}`;
  const dialog = document.createElement("dialog");
  dialog.className = "lpc-dialog";
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", descriptionId);
  dialog.dataset.tone = tone === "danger" ? "danger" : "default";

  const card = document.createElement("div");
  card.className = "lpc-dialog__card";

  const heading = document.createElement("h2");
  heading.className = "lpc-dialog__title";
  heading.id = titleId;
  heading.textContent = normalizedText(title, "Confirm action");

  const description = document.createElement("p");
  description.className = "lpc-dialog__description";
  description.id = descriptionId;
  description.textContent = normalizedText(message);

  card.append(heading, description);

  let field = null;
  if (input) {
    const label = document.createElement("label");
    label.className = "lpc-dialog__label";
    label.htmlFor = inputId;
    label.textContent = normalizedText(input.label, input.required ? "Required details" : "Details");
    field = input.multiline ? document.createElement("textarea") : document.createElement("input");
    field.id = inputId;
    field.className = "lpc-dialog__input";
    if (!input.multiline) field.type = "text";
    field.value = String(input.initialValue ?? "");
    field.maxLength = Number.isFinite(input.maxLength) ? input.maxLength : 500;
    field.required = Boolean(input.required);
    field.autocomplete = "off";
    if (input.placeholder) field.placeholder = String(input.placeholder);
    if (input.multiline) field.rows = 4;
    label.append(field);
    card.append(label);
  }

  const status = document.createElement("p");
  status.className = "lpc-dialog__status";
  status.setAttribute("role", "alert");
  status.setAttribute("aria-live", "polite");
  card.append(status);

  const actions = document.createElement("div");
  actions.className = "lpc-dialog__actions";
  let cancelButton = null;
  if (cancelLabel) {
    cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "lpc-dialog__button lpc-dialog__button--secondary";
    cancelButton.textContent = normalizedText(cancelLabel, "Cancel");
    actions.append(cancelButton);
  }
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "lpc-dialog__button lpc-dialog__button--primary";
  confirmButton.textContent = normalizedText(confirmLabel, "Confirm");
  actions.append(confirmButton);
  card.append(actions);
  dialog.append(card);
  document.body.append(dialog);

  return { dialog, field, status, cancelButton, confirmButton };
}

function presentDialog(config = {}) {
  const parts = createDialog(config);
  const { dialog, field, status, cancelButton, confirmButton } = parts;
  activeDialog = dialog;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      deactivateDialogFocus(dialog);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (activeDialog === dialog) activeDialog = null;
      resolve(result);
    };

    cancelButton?.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    confirmButton.addEventListener("click", () => {
      if (field) {
        const value = String(field.value || "").replace(/\r\n/g, "\n").trim();
        if (field.required && !value) {
          status.textContent = config.input?.requiredMessage || "Enter the requested information to continue.";
          field.focus();
          return;
        }
        finish(value);
        return;
      }
      finish(true);
    });
    field?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !field.matches("textarea")) {
        event.preventDefault();
        confirmButton.click();
      }
    });

    dialog.showModal();
    activateDialogFocus(dialog, {
      initialFocus: field || (config.tone === "danger" ? cancelButton : confirmButton),
      onEscape: () => finish(null),
    });
  });
}

function openDialog(config = {}) {
  const pending = dialogQueue.then(() => presentDialog(config), () => presentDialog(config));
  dialogQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function confirmAction(message, options = {}) {
  const result = await openDialog({
    title: options.title || "Confirm action",
    message,
    confirmLabel: options.confirmLabel || "Confirm",
    cancelLabel: options.cancelLabel || "Cancel",
    tone: options.tone || "default",
  });
  return result === true;
}

export async function promptForText(message, options = {}) {
  return openDialog({
    title: options.title || "Add details",
    message,
    confirmLabel: options.confirmLabel || "Continue",
    cancelLabel: options.cancelLabel || "Cancel",
    tone: options.tone || "default",
    input: {
      label: options.label || "Details",
      initialValue: options.initialValue || "",
      placeholder: options.placeholder || "",
      maxLength: options.maxLength,
      multiline: options.multiline !== false,
      required: Boolean(options.required),
      requiredMessage: options.requiredMessage,
    },
  });
}

export async function showAlert(message, options = {}) {
  await openDialog({
    title: options.title || "Action needed",
    message,
    confirmLabel: options.confirmLabel || "Got it",
    cancelLabel: "",
    tone: options.tone || "default",
  });
}
