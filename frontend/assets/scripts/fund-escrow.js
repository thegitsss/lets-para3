const params = new URLSearchParams(window.location.search);
const pathParts = window.location.pathname.split("/").filter(Boolean);
let caseId = params.get("caseId");
if (!caseId && pathParts.length >= 3 && pathParts[0] === "cases" && pathParts[2] === "fund-escrow") {
  caseId = pathParts[1];
}

const cardErrors = document.getElementById("card-errors");
const amountEl = document.getElementById("lockedAmount");
const titleEl = document.getElementById("caseTitle");
const statusEl = document.getElementById("caseStatus");
const statusMsg = document.getElementById("statusMsg");
const paymentPane = document.getElementById("paymentPane");
const fundBtn = document.getElementById("fundBtn");
let stripe;
let elements;
let card;

function formatCents(cents) {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function showError(msg) {
  if (cardErrors) cardErrors.textContent = msg || "";
  if (statusMsg) statusMsg.textContent = msg || "";
}

function readToken() {
  try {
    const raw = localStorage.getItem("lpc_token");
    return raw || "";
  } catch {
    return "";
  }
}

async function loadCase() {
  const headers = new Headers();
  const token = readToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { headers, credentials: "include" });
  if (!res.ok) throw new Error("Unable to load case.");
  return res.json();
}

async function loadStripe() {
  if (typeof Stripe === "undefined") throw new Error("We couldn't load the secure payment form. Please allow js.stripe.com or disable ad blockers and try again.");
  const res = await fetch("/api/payments/config", { credentials: "include" });
  const data = await res.json();
  if (!data?.publishableKey) throw new Error("Stripe publishable key missing.");
  stripe = Stripe(data.publishableKey);
  elements = stripe.elements();
  card = elements.create("card", {
    style: {
      base: { fontSize: "16px", color: "#222" },
      invalid: { color: "#b00020" },
    },
  });
  card.mount("#card-element");
  card.on("change", (evt) => {
    if (cardErrors) cardErrors.textContent = evt.error?.message || "";
  });
}

async function createIntent() {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = readToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`/api/payments/intent/${encodeURIComponent(caseId)}`, {
    method: "POST",
    headers,
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || "Unable to start escrow.");
  }
  return body;
}

async function fund() {
  if (!stripe || !card) return;
  fundBtn.disabled = true;
  fundBtn.textContent = "Processing…";
  showError("");
  try {
    const intent = await createIntent();
    const result = await stripe.confirmCardPayment(intent.clientSecret, {
      payment_method: { card },
    });
    if (result.error) {
      throw new Error(result.error.message || "Payment failed.");
    }
    if (result.paymentIntent?.status === "succeeded") {
      window.location.href = `case-detail.html?caseId=${encodeURIComponent(caseId)}`;
      return;
    }
    throw new Error("Payment not completed.");
  } catch (err) {
    showError(err?.message || "Unable to fund escrow.");
  } finally {
    fundBtn.disabled = false;
    fundBtn.textContent = "Hire & Start Work";
  }
}

(async () => {
  if (!caseId) {
    showError("Missing case id.");
    return;
  }
  try {
    const caseData = await loadCase();
    titleEl.textContent = caseData.title || "Case";
    statusEl.textContent = `Status: ${caseData.escrowStatus || caseData.status || "N/A"}`;
    const locked = Number(caseData.lockedTotalAmount ?? caseData.totalAmount);
    amountEl.textContent = formatCents(locked);
    if (String(caseData.escrowStatus || "").toLowerCase() === "funded") {
      statusEl.textContent = "Escrow funded.";
      return;
    }
    await loadStripe();
    paymentPane.style.display = "block";
  } catch (err) {
    showError(err?.message || "Unable to load funding screen.");
  }
})();

fundBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  fund();
});
