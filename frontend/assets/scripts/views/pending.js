// frontend/assets/scripts/views/pending.js
import { clearSession } from "../auth.js";

let stylesInjected = false;

export function render(el) {
  ensureStyles();
  el.innerHTML = `
    <section class="pending-view">
      <div class="card">
        <h1>Account Pending Approval</h1>
        <p>Your account is pending approval. You will receive an email once an administrator approves your access.</p>
        <button class="btn" data-act="logout">Log out</button>
      </div>
    </section>
  `;

  el.querySelector("[data-act=logout]")?.addEventListener("click", () => {
    clearSession();
    window.location.href = "index.html";
  });
}

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = `
    .pending-view{min-height:60vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .pending-view .card{max-width:460px;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px;text-align:center;box-shadow:0 10px 30px rgba(15,23,42,.08)}
    .pending-view h1{font-size:1.5rem;margin-bottom:12px}
    .pending-view p{color:#475467;margin-bottom:24px;line-height:1.5}
    .pending-view .btn{border:0;border-radius:999px;padding:12px 24px;background:#111827;color:#fff;font-weight:600;cursor:pointer}
  `;
  document.head.appendChild(style);
  stylesInjected = true;
}
