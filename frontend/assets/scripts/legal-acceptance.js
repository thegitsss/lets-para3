import { logout, secureFetch } from "./auth.js";

const form = document.getElementById("legalAcceptanceForm");
const termsAccepted = document.getElementById("termsAccepted");
const privacyAcknowledged = document.getElementById("privacyAcknowledged");
const continueButton = document.getElementById("continueButton");
const signOutButton = document.getElementById("signOutButton");
const status = document.getElementById("legalStatus");
const signedInEmail = document.getElementById("signedInEmail");

let sessionUser = null;

function setStatus(message = "", state = "error") {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function syncSubmitState() {
  if (!continueButton) return;
  continueButton.disabled = !(termsAccepted?.checked && privacyAcknowledged?.checked);
}

function dashboardForRole(role) {
  const normalized = String(role || "").toLowerCase();
  if (normalized === "admin") return "admin-dashboard.html";
  if (normalized === "director") return "director-portal.html";
  if (normalized === "paralegal") return "dashboard-paralegal.html";
  return "dashboard-attorney.html";
}

async function loadSession() {
  try {
    const session = await window.checkSession?.(undefined, { redirectOnFail: true });
    sessionUser = session?.user || null;
    if (!sessionUser) return;
    if (signedInEmail) signedInEmail.textContent = sessionUser.email || "your LPC account";
    if (sessionUser.legalAcceptanceRequired !== true) {
      window.location.replace(dashboardForRole(sessionUser.role));
    }
  } catch (error) {
    if (error?.code !== "LEGAL_ACCEPTANCE_REQUIRED") {
      setStatus("We could not verify your session. Sign in again to continue.");
    }
  }
}

termsAccepted?.addEventListener("change", syncSubmitState);
privacyAcknowledged?.addEventListener("change", syncSubmitState);

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!(termsAccepted?.checked && privacyAcknowledged?.checked)) {
    setStatus("Select both acknowledgements to continue.");
    termsAccepted?.focus();
    return;
  }

  continueButton.disabled = true;
  continueButton.textContent = "Recording acceptance…";
  setStatus("");
  try {
    const response = await secureFetch("/api/account/legal-acceptance", {
      method: "POST",
      headers: { Accept: "application/json" },
      body: {
        termsAccepted: true,
        privacyAcknowledged: true,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.legalAcceptanceRequired === true) {
      throw new Error(payload?.error || "Your acceptance could not be recorded.");
    }

    window.updateSessionUser?.({
      legalAcceptanceRequired: false,
      legalAcceptance: payload.legalAcceptance,
    });
    setStatus("Acceptance recorded. Taking you to your dashboard…", "success");
    window.location.replace(dashboardForRole(sessionUser?.role));
  } catch (error) {
    setStatus(error?.message || "Your acceptance could not be recorded. Try again.");
    syncSubmitState();
    continueButton.textContent = "Accept and continue";
  }
});

signOutButton?.addEventListener("click", async () => {
  signOutButton.disabled = true;
  const loggedOut = await logout(null);
  if (!loggedOut) {
    signOutButton.disabled = false;
    setStatus("Your session could not be ended. Check your connection and try again.");
    return;
  }
  window.clearStoredSession?.();
  window.location.replace("login.html");
});

syncSubmitState();
loadSession();
