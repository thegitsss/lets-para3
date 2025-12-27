import { secureFetch } from "./auth.js";

//
// --- CASE + ELEMENTS ---
//
const params = new URLSearchParams(window.location.search);
const CASE_ID = params.get("caseId") || params.get("id");

const tasksContainer = document.getElementById("caseTasksContainer");
const openModalBtn = document.getElementById("openTaskModalBtn");
const modal = document.getElementById("taskModal");
const cancelBtn = document.getElementById("cancelTaskBtn");
const saveBtn = document.getElementById("saveTaskBtn");
const tasksGate = document.getElementById("caseTasksGate");
const caseAmountNode = document.getElementById("caseAmount");
const caseTitleNode = document.getElementById("caseTitle");
const caseStatusBadge = document.getElementById("caseStatusBadge");
const fundPromptNode = document.getElementById("fundingPrompt");
const fundEscrowBtn = document.getElementById("fundEscrowBtn");
const workLockedBanner = document.getElementById("workLockedBanner");
const caseActionsRoot = document.querySelector(".case-header-actions");

const titleInput = document.getElementById("taskTitleInput");
const descInput = document.getElementById("taskDescInput");
const dueInput = document.getElementById("taskDueInput");

let currentTasks = [];
let escrowFunded = true;
let hasParalegal = true;
let workLocked = false;

//
// --- ROLE VISIBILITY ---
//
function applyRoleVisibility(user) {
  const role = String(user?.role || "").toLowerCase();

  // Hide attorney-only items from paralegals
  document.querySelectorAll("[data-attorney-only]").forEach((el) => {
    if (role === "paralegal") el.style.display = "none";
  });

  // Hide paralegal-only items from attorneys
  document.querySelectorAll("[data-paralegal-only]").forEach((el) => {
    if (role === "attorney") el.style.display = "none";
  });
}

function renderTaskGate() {
  if (!tasksGate) return;
  if (workLocked) {
    tasksGate.classList.remove("hidden");
    tasksGate.textContent = "Work begins once payment is secured.";
    openModalBtn?.setAttribute("disabled", "disabled");
    return;
  }
  if (!hasParalegal) {
    tasksGate.classList.remove("hidden");
    tasksGate.textContent = "Hire & start work to enable tasks and messaging.";
    openModalBtn?.setAttribute("disabled", "disabled");
    return;
  }
  if (!escrowFunded) {
    tasksGate.classList.remove("hidden");
    tasksGate.textContent = "Payment is processing. Tasks unlock once funding clears.";
    openModalBtn?.setAttribute("disabled", "disabled");
    return;
  }
  tasksGate.classList.add("hidden");
  tasksGate.textContent = "";
  openModalBtn?.removeAttribute("disabled");
}

async function loadCaseMeta() {
  if (!CASE_ID) return;
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(CASE_ID)}`, { noRedirect: true });
    if (!res.ok) return;
    const payload = await res.json();
    const fundedStatus = String(payload?.escrowStatus || "").toLowerCase() === "funded";
    escrowFunded = !!payload?.escrowIntentId && fundedStatus;
    hasParalegal = !!payload?.paralegal;
    workLocked = hasParalegal && !escrowFunded;
    const amountCents = Number(
      (payload && (payload.lockedTotalAmount ?? payload.totalAmount)) || 0
    );
    if (caseAmountNode) {
      const display = amountCents > 0 ? formatCurrency(amountCents / 100) : "—";
      caseAmountNode.textContent = `Posted amount: ${display}`;
    }
    if (fundPromptNode) {
      fundPromptNode.classList.toggle("hidden", !hasParalegal || escrowFunded);
    }
    if (fundEscrowBtn) {
      fundEscrowBtn.classList.toggle("hidden", !hasParalegal || escrowFunded);
    }
    if (caseTitleNode && payload?.title) {
      caseTitleNode.textContent = payload.title;
    }
    if (caseStatusBadge && payload?.status) {
      const cleanStatus = String(payload.status).replace(/_/g, " ").toUpperCase();
      caseStatusBadge.textContent = cleanStatus;
    }
  } catch {
    /* ignore meta failures to avoid blocking tasks */
  } finally {
    applyWorkLock();
    renderTaskGate();
  }
}

//
// --- NOTIFY UTILITY ---
//
function notify(message, type = "info") {
  if (window.toastUtils?.stage) {
    window.toastUtils.stage(message, type);
  } else {
    alert(message);
  }
}

//
// --- TASK RENDERING ---
//
function renderTasks(tasks = []) {
  if (!tasksContainer) return;

  if (!tasks.length) {
    tasksContainer.innerHTML = `<p style="color:var(--muted);">No tasks yet.</p>`;
    return;
  }

  tasksContainer.innerHTML = tasks
    .map(
      (task) => `
      <article class="task-card">
        <h3>${escapeHtml(task.title)}</h3>
        <p>${escapeHtml(task.description || "")}</p>
        <div class="task-meta">
          <span>Status: ${escapeHtml(task.status.replace(/_/g, " "))}</span>
          <span>Due: ${
            task.dueDate
              ? new Date(task.dueDate).toLocaleDateString()
              : "—"
          }</span>
        </div>
      </article>
    `
    )
    .join("");
}

function escapeHtml(str = "") {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

//
// --- LOAD TASKS ---
//
async function loadTasks() {
  if (!CASE_ID) return;
  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(CASE_ID)}/tasks`, {
      noRedirect: true,
    });
    if (res.status === 401 || res.status === 403) {
      currentTasks = [];
      if (tasksContainer) {
        tasksContainer.innerHTML = `<p style="color:var(--muted);">Tasks will appear here once you are on this case.</p>`;
      }
      return;
    }
    if (!res.ok) throw new Error("Could not load tasks.");
    const payload = await res.json();
    currentTasks = payload?.tasks || [];
    renderTasks(currentTasks);
  } catch (err) {
    notify("Unable to load tasks.", "err");
  }
}

//
// --- SAVE TASK ---
//
async function saveTask() {
  const title = titleInput?.value.trim();
  const description = descInput?.value.trim();
  const dueDate = dueInput?.value;

  if (!title) {
    notify("Task title is required.", "err");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const res = await secureFetch(`/api/cases/${encodeURIComponent(CASE_ID)}/tasks`, {
      method: "POST",
      body: { title, description, dueDate, status: "todo" },
      noRedirect: true,
    });

    const payload = await res.json().catch(() => ({}));

    if (res.status === 401 || res.status === 403) {
      const msg = payload?.error || "You need to be on this case to create tasks.";
      notify(msg, "err");
      if (msg.toLowerCase().includes("escrow")) {
        escrowFunded = false;
        renderTaskGate();
      }
      return;
    }

    if (!res.ok) throw new Error(payload?.error || "Could not create task.");

    const { task } = payload;

    currentTasks = [task, ...currentTasks];
    renderTasks(currentTasks);

    modal.classList.remove("show");
    titleInput.value = "";
    descInput.value = "";
    dueInput.value = "";

    notify("Task created!", "success");
  } catch (err) {
    notify(err?.message || "Unable to create task.", "err");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Task";
  }
}

//
// --- MODAL CONTROL ---
//
openModalBtn?.addEventListener("click", () => {
  if (workLocked) {
    notify("Work begins once payment is secured.", "err");
    return;
  }
  if (!hasParalegal) {
    notify("Hire a paralegal before creating tasks.", "err");
    return;
  }
  if (!escrowFunded) {
    notify("Payment is still processing. Try again once work is unlocked.", "err");
    return;
  }
  modal.classList.add("show");
});
cancelBtn?.addEventListener("click", () => modal.classList.remove("show"));
modal?.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.remove("show");
});
saveBtn?.addEventListener("click", saveTask);

//
// --- INITIALIZE PAGE ---
//
(async () => {
  // Get user from local/session storage
  let user = null;
  if (typeof window.getStoredUser === "function") {
    user = window.getStoredUser();
  } else {
    const raw = localStorage.getItem("lpc_user");
    if (raw) user = JSON.parse(raw);
  }

  if (user) applyRoleVisibility(user);

  await loadCaseMeta();
  await loadTasks();
  renderTaskGate();
})();

function applyWorkLock() {
  document.body.classList.toggle("work-locked", !!workLocked);
  workLockedBanner?.classList.toggle("hidden", !workLocked);
  const lockTargets = [openModalBtn, fundEscrowBtn, primaryInviteBtn, caseOptionsRoot];
  lockTargets.forEach((el) => {
    if (!el) return;
    const isControl =
      el.tagName === "BUTTON" ||
      el.tagName === "SUMMARY" ||
      el.tagName === "DETAILS" ||
      el.getAttribute("role") === "button";
    if (workLocked) {
      if (isControl) el.setAttribute("disabled", "disabled");
      el.classList.add("locked");
    } else {
      if (isControl) el.removeAttribute("disabled");
      el.classList.remove("locked");
    }
  });
  if (caseActionsRoot) {
    caseActionsRoot.classList.toggle("locked", !!workLocked);
  }
}

function formatCurrency(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return "$0.00";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
