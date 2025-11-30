// frontend/assets/scripts/forgot-password.js
import { j } from "./helpers.js";

const form = document.getElementById("forgotPasswordForm");
const email = document.getElementById("email");
const msg = document.getElementById("msg");
const submitBtn = form?.querySelector('button[type="submit"]');
const defaultText = submitBtn?.textContent || "Send reset link";

function show(t) { if (msg) msg.textContent = t || ""; }

if (form) {
  const scheduleReset = () => {
    if (!form || !submitBtn) return;
    const handler = () => {
      submitBtn.disabled = false;
      submitBtn.textContent = defaultText;
      form.removeEventListener("input", handler);
    };
    form.addEventListener("input", handler, { once: true });
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const emailVal = (email?.value || "").trim().toLowerCase();
    if (!emailVal) { show("Please enter your email."); return; }

    show("Sending reset link…");
    const buttonLabel = submitBtn?.textContent || defaultText;
    let restoreButton = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }

    try {
      await j("/api/auth/request-password-reset", {
        method: "POST",
        body: { email: emailVal }
      });
      show("If this email is registered, a reset link will be sent shortly.");
      scheduleReset();
      restoreButton = false;
    } catch (err) {
      const text = err?.data?.msg || err?.data?.error || "Failed to send reset email.";
      show(text);
    } finally {
      if (restoreButton && submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = buttonLabel;
      }
    }
  });
}
