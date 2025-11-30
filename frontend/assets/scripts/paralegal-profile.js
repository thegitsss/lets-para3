// Public paralegal profile view

const card = document.getElementById("profileCard");

function getId() {
  const params = new URLSearchParams(window.location.search || "");
  return params.get("id") || params.get("paralegalId");
}

function initials(name = "") {
  return name
    .split(" ")
    .filter(Boolean)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "PL";
}

function renderProfile(data) {
  if (!card) return;
  const name = data.name || `${data.firstName || ""} ${data.lastName || ""}`.trim() || "Paralegal";
  const specialties = (data.specialties || data.practiceAreas || []).filter(Boolean);
  const education = Array.isArray(data.education) ? data.education : [];
  const availability = data.availability || "Availability not set";
  const location = data.location || "Location unavailable";
  const years = typeof data.yearsExperience === "number" && data.yearsExperience >= 0
    ? `${data.yearsExperience} year${data.yearsExperience === 1 ? "" : "s"} experience`
    : "Experience unavailable";

  card.innerHTML = `
    <div class="hero">
      ${
        data.profileImage || data.avatarURL
          ? `<img class="avatar" alt="${escapeHtml(name)} avatar" src="${escapeAttribute(
              data.profileImage || data.avatarURL
            )}">`
          : `<div class="avatar">${escapeHtml(initials(name))}</div>`
      }
      <div>
        <h1>${escapeHtml(name)}</h1>
        <div class="meta">${escapeHtml(location)} · ${escapeHtml(years)}</div>
        <div class="meta">${escapeHtml(availability)}</div>
        <div class="cta-bar">
          <a class="btn" href="login.html">Log in to hire</a>
          <a class="btn secondary" href="signup.html">Create attorney account</a>
        </div>
      </div>
    </div>

    <div class="grid">
      <div>
        <div class="section-title">Specialties</div>
        ${
          specialties.length
            ? specialties.map((s) => `<span class="pill">${escapeHtml(s)}</span>`).join("")
            : `<div class="empty">No specialties listed.</div>`
        }
      </div>

      <div>
        <div class="section-title">Bio</div>
        <div>${escapeHtml(data.bio || data.about || "No bio provided yet.")}</div>
      </div>

      <div>
        <div class="section-title">Education</div>
        ${
          education.length
            ? education
                .map((item) => {
                  const degree = item.degree ? String(item.degree).trim() : "";
                  const school = item.school ? String(item.school).trim() : "";
                  return `<div>${escapeHtml([degree, school].filter(Boolean).join(" · ") || school || degree)}</div>`;
                })
                .join("")
            : `<div class="empty">No education listed.</div>`
        }
      </div>

      ${
        data.linkedInURL
          ? `<div><div class="section-title">LinkedIn</div><a href="${escapeAttribute(
              data.linkedInURL
            )}" target="_blank" rel="noopener">${escapeHtml(data.linkedInURL)}</a></div>`
          : ""
      }
    </div>
  `;
}

function renderError(message) {
  if (!card) return;
  card.innerHTML = `<div class="meta" style="color:#b91c1c">${escapeHtml(message || "Profile not available.")}</div>`;
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

async function loadProfile(id) {
  const res = await fetch(`/api/public/paralegals/${encodeURIComponent(id)}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.msg || "Unable to load profile.");
  }
  return res.json();
}

(async function boot() {
  const id = getId();
  if (!id) {
    renderError("Missing paralegal id.");
    return;
  }
  try {
    const profile = await loadProfile(id);
    renderProfile(profile);
  } catch (err) {
    renderError(err?.message);
  }
})();
