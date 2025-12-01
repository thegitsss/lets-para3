// frontend/assets/scripts/views/browse-paralegals.js
// Lightweight directory that pulls real paralegal data directly from /api/users/paralegals

const grid = document.getElementById("paralegalGrid");
const pagination = document.getElementById("paralegalPagination");
const statusNode = document.getElementById("resultsStatus");

const DEFAULT_PAGE_SIZE = 12;
const PLACEHOLDER_AVATAR = "https://via.placeholder.com/120?text=PL";
function getProfileImageUrl(user = {}) {
  return user.profileImage || user.avatarURL || "assets/images/default-avatar.png";
}

const state = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
};

function init() {
  if (!grid || !pagination) return;
  grid.addEventListener("click", onGridClick);
  void hydrate(1);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void hydrate(1);
  }, { once: true });
} else {
  void hydrate(1);
}

async function hydrate(page = 1) {
  try {
    setStatus("Loading paralegals…");
    const payload = await loadParalegals(page, state.pageSize);
    state.page = payload.page || page;
    state.pageSize = payload.pageSize || payload.limit || state.pageSize;
    state.total = payload.total ?? payload.items?.length ?? 0;
    renderGrid(Array.isArray(payload.items) ? payload.items : []);
    renderPagination(payload);
    if (!payload.items?.length) {
      setStatus("No paralegals found.");
    } else {
      setStatus("");
    }
  } catch (err) {
    console.warn("Unable to load paralegals", err);
    renderGrid([]);
    renderPagination({ total: 0, page: 1, pageSize: state.pageSize });
    setStatus(err?.message || "Unable to load paralegals.", true);
  }
}

export async function loadParalegals(page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(pageSize),
  });
  const res = await fetch(`/api/public/paralegals?${params.toString()}`, {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  const payload = await res.json();
  if (!res.ok) {
    const message = payload?.error || payload?.msg || "Unable to load paralegals.";
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  if (!payload.pageSize) {
    payload.pageSize = payload.limit || pageSize;
  }
  return payload;
}

function renderGrid(items = []) {
  grid.innerHTML = "";
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "No paralegals available right now.";
    grid.appendChild(empty);
    return;
  }
  items.forEach((paralegal) => {
    const card = document.createElement("div");
    card.className = "pl-card";

    const avatar = document.createElement("img");
    avatar.className = "pl-avatar";
    avatar.alt = `${formatName(paralegal)} avatar`;
    avatar.src = getProfileImageUrl(paralegal) || PLACEHOLDER_AVATAR;

    const name = document.createElement("div");
    name.className = "pl-name";
    name.textContent = formatName(paralegal);

    const meta = document.createElement("div");
    meta.className = "pl-meta";
    meta.innerHTML = `
      <span>${formatState(paralegal)}</span>
      <span>${formatYears(paralegal.yearsExperience)}</span>
      <span>${formatSpecialties(paralegal)}</span>
    `;

    const details = document.createElement("div");
    details.className = "pl-details";
    details.innerHTML = `
      ${buildLinkedInSnippet(paralegal)}
      ${buildEducationSnippet(paralegal)}
      ${buildCertificateSnippet(paralegal)}
    `;

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "pl-view-btn";
    viewBtn.dataset.id = String(paralegal._id || paralegal.id || "");
    viewBtn.textContent = "View Profile";

    card.appendChild(avatar);
    card.appendChild(name);
    card.appendChild(meta);
    card.appendChild(details);
    card.appendChild(viewBtn);
    grid.appendChild(card);
  });
}

function renderPagination(meta = {}) {
  pagination.innerHTML = "";
  const total = Number(meta.total) || 0;
  const pageSize = Number(meta.pageSize || meta.limit || state.pageSize || DEFAULT_PAGE_SIZE);
  const currentPage = Number(meta.page) || 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  for (let page = 1; page <= totalPages; page += 1) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = String(page);
    btn.className = "pagination-btn";
    btn.disabled = page === currentPage;
    btn.dataset.page = String(page);
    pagination.appendChild(btn);
  }
}

function onGridClick(event) {
  const button = event.target.closest(".pl-view-btn");
  if (!button || !button.dataset.id) return;
  const targetId = button.dataset.id;
  window.location.href = `paralegal-profile.html?id=${encodeURIComponent(targetId)}`;
}

function setStatus(message, isError = false) {
  if (!statusNode) return;
  statusNode.textContent = message;
  statusNode.style.display = message ? "block" : "none";
  statusNode.style.color = isError ? "#b91c1c" : "";
}

function formatName(paralegal = {}) {
  const full = [paralegal.firstName, paralegal.lastName].filter(Boolean).join(" ").trim();
  return full || paralegal.name || "Paralegal";
}

function formatState(paralegal = {}) {
  return paralegal.state || paralegal.location || paralegal.region || "Location unavailable";
}

function formatYears(value) {
  const years = Number(value);
  if (!Number.isFinite(years) || years < 0) return "Experience unavailable";
  if (years === 1) return "1 year";
  return `${years} years`;
}

function formatSpecialties(paralegal = {}) {
  const entries = Array.isArray(paralegal.specialties)
    ? paralegal.specialties
    : Array.isArray(paralegal.practiceAreas)
    ? paralegal.practiceAreas
    : [];
  if (!entries.length) return "Specialties unavailable";
  return entries.slice(0, 3).join(", ");
}

function buildLinkedInSnippet(paralegal = {}) {
  if (!paralegal.linkedInURL) return "";
  const safe = escapeAttribute(paralegal.linkedInURL);
  return `<p>LinkedIn: <a href="${safe}" target="_blank" rel="noopener">View profile</a></p>`;
}

function buildEducationSnippet(paralegal = {}) {
  const list = Array.isArray(paralegal.education) ? paralegal.education : [];
  if (!list.length) return "";
  const entry = list.find((item) => item && (item.degree || item.school)) || list[0];
  if (!entry) return "";
  const degree = entry.degree ? String(entry.degree).trim() : "";
  const school = entry.school ? String(entry.school).trim() : "";
  const parts = [degree, school].filter(Boolean).join(" · ");
  if (!parts) return "";
  return `<p>Education: ${escapeHtml(parts)}</p>`;
}

function buildCertificateSnippet(paralegal = {}) {
  if (!paralegal.certificateURL) return "";
  const safe = escapeAttribute(paralegal.certificateURL);
  return `<p>Certificate: <a href="${safe}" target="_blank" rel="noopener">View</a></p>`;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value = "") {
  return String(value).replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

pagination?.addEventListener("click", (event) => {
  const btn = event.target.closest(".pagination-btn");
  if (!btn || btn.disabled) return;
  const nextPage = Number(btn.dataset.page) || 1;
  if (nextPage === state.page) return;
  state.page = nextPage;
  void hydrate(nextPage);
});
