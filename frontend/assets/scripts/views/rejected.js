// frontend/assets/scripts/views/rejected.js

import { logout } from "../auth.js";

let stylesInjected = false;

export function loadRejectedView(root, { navigateTo } = {}) {
  ensureStyles();
  root.innerHTML = `
    <section class="rejected-view">
      <div class="card">
        <h2>Your account was not approved.</h2>
        <p>Please contact support or submit a new application.</p>
        <button id="logoutBtn" type="button">Log Out</button>
      </div>
    </section>
  `;

  root.querySelector("#logoutBtn")?.addEventListener("click", () => logout("login.html"));
}

export const render = loadRejectedView;

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .rejected-view{min-height:60vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .rejected-view .card{max-width:480px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;text-align:center;box-shadow:0 10px 30px rgba(15,23,42,0.08)}
    .rejected-view h2{font-size:1.5rem;margin-bottom:12px;color:#111827}
    .rejected-view p{color:#475467;margin-bottom:24px;line-height:1.5}
    .rejected-view button{border:0;border-radius:999px;padding:12px 24px;background:#111827;color:#fff;font-weight:600;cursor:pointer}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}
