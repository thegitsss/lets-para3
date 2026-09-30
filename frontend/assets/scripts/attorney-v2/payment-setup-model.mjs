const objectId = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
const invalid = () => { throw new Error("invalid_payment_setup"); };
export function readHiringReturn(value, ownerId) {
  if (!value || value.ownerId !== ownerId || !/^[a-f0-9]{64}$/.test(value.revision || "")) invalid();
  const entry = value.pending;
  if (entry !== null && (!entry || !["available", "unavailable", "earlier"].includes(entry.state) || entry.state !== "earlier" && (!objectId(entry.caseId) || !objectId(entry.paralegalId)) || entry.state === "available" && (typeof entry.caseTitle !== "string" || typeof entry.paralegalName !== "string"))) invalid();
  return { ownerId, revision: value.revision, pending: entry };
}
export function hiringReturnHref(value, { current = false } = {}) {
  if (value?.state !== "available" || !objectId(value.caseId) || !objectId(value.paralegalId)) return null;
  return current ? `/dashboard-attorney.html?caseId=${value.caseId}&applicantId=${value.paralegalId}&openApplicant=1&continueHire=1#cases:inquiries` : `#/matters/${value.caseId}/applications?applicantId=${value.paralegalId}`;
}
export function readCard(value) {
  if (!value || typeof value.id !== "string" || !/^pm_[A-Za-z0-9_]{1,200}$/.test(value.id) || value.type !== "card" || typeof value.brand !== "string" || !/^[a-z0-9_ -]{1,40}$/i.test(value.brand) || !/^\d{4}$/.test(value.last4 || "") || !Number.isInteger(value.exp_month) || value.exp_month < 1 || value.exp_month > 12 || !Number.isInteger(value.exp_year) || value.exp_year < 2000 || value.exp_year > 2200) invalid();
  return { id: value.id, brand: value.brand, last4: value.last4, month: value.exp_month, year: value.exp_year };
}
export function readDefaultCard(value) {
  if (typeof value?.hasDefault !== "boolean") invalid();
  if (value.devBypass === true && value.hasDefault && value.paymentMethod === null) return { bypass: true, card: null };
  if (value.hasDefault) return { bypass: false, card: readCard(value.paymentMethod) };
  if (value.paymentMethod !== null) invalid();
  return { bypass: false, card: null };
}
export function readSetup(value, ownerId, intentId) {
  if (value?.ownerId !== ownerId || value.intentId !== intentId || !/^seti_[A-Za-z0-9]{1,200}$/.test(intentId || "") || !["requires_payment_method", "requires_confirmation", "requires_action", "processing", "canceled", "succeeded"].includes(value.status)) invalid();
  if (value.status !== "succeeded" && value.paymentMethod !== null) invalid();
  return { intentId, status: value.status, card: value.status === "succeeded" ? readCard(value.paymentMethod) : null };
}
export function cardLabel(card) { return `${card.brand.replace(/_/g, " ")} ending in ${card.last4} · expires ${String(card.month).padStart(2, "0")}/${card.year}`; }
export function setupMessage(status) {
  return ({ succeeded: "Card verified. Review it below before making it the default.", processing: "The card provider is still processing this setup. Check again before continuing.", requires_action: "Card authentication is incomplete. Check the provider's authentication window, then check this setup again.", requires_confirmation: "This card setup has not been confirmed.", requires_payment_method: "The provider needs valid card details to finish this setup.", canceled: "This card setup was canceled." })[status];
}
export function paymentSetupError(error) {
  if (error?.kind === "authentication" || error?.code === "PAYMENT_SETUP_ACCOUNT_CHANGED") return "Your account changed. Sign in again before continuing.";
  if (error?.status === 409) return "The saved details changed or could not be verified. Refresh them before continuing.";
  if (error?.status === 403 || error?.status === 404) return "These details are no longer available to your account.";
  return "The result could not be confirmed. Check the saved details before trying again.";
}
// Remove provider callback credentials before subsequent page requests. Only the
// non-secret intent identifier is retained, and the server verifies its owner.
export function consumeSetupReturn(href) {
  const url = new URL(href), keys = ["setup_intent", "setup_intent_client_secret", "redirect_status"];
  const present = keys.some(key => url.searchParams.has(key));
  const id = url.searchParams.get("setup_intent"); keys.forEach(key => url.searchParams.delete(key));
  if (present) url.hash = "#/payments/setup";
  return { present, intentId: /^seti_[A-Za-z0-9]{1,200}$/.test(id || "") ? id : null, cleanUrl: `${url.pathname}${url.search}${url.hash}` };
}
