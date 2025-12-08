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

const titleInput = document.getElementById("taskTitleInput");
const descInput = document.getElementById("taskDescInput");
const dueInput = document.getElementById("taskDueInput");

let currentTasks = [];

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
    const res = await secureFetch(`/api/cases/${encodeURIComponent(CASE_ID)}/tasks`);
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
      body: { title, description, dueDate, status: "todo" }
    });

    if (!res.ok) throw new Error("Could not create task.");

    const { task } = await res.json();

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
openModalBtn?.addEventListener("click", () => modal.classList.add("show"));
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

  await loadTasks();
})();
