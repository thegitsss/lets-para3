// frontend/assets/scripts/forgot-password.js
import { j } from "./helpers.js";

const form = document.getElementById("forgotPasswordForm");
const email = document.getElementById("email");
const msg = document.getElementById("msg");

function show(t) { if (msg) msg.textContent = t || ""; }

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const emailVal = (email?.value || "").trim().toLowerCase();
    if (!emailVal) { show("Please enter your email."); return; }

    show("Sending reset link…");

    try {
      await j("/api/auth/request-password-reset", {
        method: "POST",
        body: { email: emailVal }
      });
      show("If this email is registered, a reset link will be sent shortly.");
    } catch (err) {
      const text = err?.data?.msg || err?.data?.error || "Failed to send reset email.";
      show(text);
    }
  });
}
