// frontend/assets/scripts/login.js
import { j } from "./helpers.js";

const form = document.getElementById("loginForm");
const email = document.getElementById("email");
const password = document.getElementById("password");
const msg = document.getElementById("msg");
const bypass = document.getElementById("devBypass");
const caps = document.getElementById("caps"); // optional span for caps warning

function show(t) { if (msg) msg.textContent = t || ""; }

window.togglePassword = function () {
  const toggle = document.querySelector(".show-toggle");
  if (!password || !toggle) return;
  if (password.type === "password") { password.type = "text"; toggle.textContent = "Hide"; }
  else { password.type = "password"; toggle.textContent = "Show"; }
};

let submitting = false;

if (password && caps) {
  password.addEventListener("keyup", (e) => {
    const on = e.getModifierState && e.getModifierState("CapsLock");
    caps.style.visibility = on ? "visible" : "hidden";
  });
}

if (form) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return;
    show("");

    const emailVal = (email?.value || "").trim().toLowerCase();
    const passVal  = password?.value || "";
    if (!emailVal || !passVal) { show("Email and password are required."); return; }

    // Optional reCAPTCHA (backend skips in development)
    let recaptchaToken = "";
    if (window.grecaptcha && typeof grecaptcha.getResponse === "function") {
      recaptchaToken = grecaptcha.getResponse();
      if (!recaptchaToken) { show("Please verify you are not a robot."); return; }
    }

    // Disable while submitting
    submitting = true;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn?.setAttribute("disabled", "true");
    submitBtn?.classList.add("disabled");
    show("Signing in…");

    try {
      await j("/api/auth/login", {
        method: "POST",
        body: { email: emailVal, password: passVal, recaptchaToken }
      });
      location.href = "index.html"; // cookie is set by the server
    } catch (err) {
      const text = err?.data?.msg || err?.data?.error || "Login failed. Check your email and password.";
      show(text);
      try { window.grecaptcha?.reset?.(); } catch {}
    } finally {
      submitting = false;
      submitBtn?.removeAttribute("disabled");
      submitBtn?.classList.remove("disabled");
    }
  });
}

// Dev bypass: app shell does its own session check
if (bypass) {
  bypass.addEventListener("click", (e) => {
    e.preventDefault();
    location.href = "index.html";
  });
}
