import { secureFetch } from "./auth.js";

// Public paralegal profile view

const card = document.getElementById("profileCard");
const params = new URLSearchParams(window.location.search);
const isMe = params.get("me") === "1";
const paralegalId = params.get("paralegalId");

function safeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.items)) return value.items;
  return [];
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

function renderProfile(profile = {}) {
  if (!card) return;
  const fullName = (profile.name || `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || "").trim();
  const displayName = fullName || "Paralegal";
  const specialtiesSource = profile.specialties || profile.practiceAreas || profile.skills || [];
  const specialties = safeArray(specialtiesSource).filter(Boolean);
  const education = safeArray(profile.education);
  const availability =
    (typeof profile.availability === "string" && profile.availability.trim()) ||
    profile.availability?.status ||
    profile.availability?.label ||
    "Availability not set";
  const location =
    profile.location ||
    [profile.city, profile.state].filter(Boolean).join(", ") ||
    profile.state ||
    profile.country ||
    "Location unavailable";
  const yearsValue = typeof profile.yearsExperience === "number" ? profile.yearsExperience : profile.experience?.years;
  const years =
    typeof yearsValue === "number" && yearsValue >= 0
      ? `${yearsValue} year${yearsValue === 1 ? "" : "s"} experience`
      : "Experience unavailable";
  const bioCopy = profile.bio || profile.about || profile.summary || "No bio provided yet.";
  const linkedIn = profile.linkedInURL || profile.linkedInUrl || profile.linkedIn || profile.linkedin || "";
  const profileImage = profile.profileImage || profile.avatarURL || profile.avatar || "";

  card.innerHTML = `
    <div class="hero">
      ${
        profileImage
          ? `<img class="avatar" alt="${escapeHtml(displayName)} avatar" src="${escapeAttribute(profileImage)}">`
          : `<div class="avatar">${escapeHtml(initials(displayName))}</div>`
      }
      <div>
        <h1 id="profileName">${escapeHtml(displayName)}</h1>
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
        <div>${escapeHtml(bioCopy)}</div>
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
        linkedIn
          ? `<div><div class="section-title">LinkedIn</div><a href="${escapeAttribute(
              linkedIn
            )}" target="_blank" rel="noopener">${escapeHtml(linkedIn)}</a></div>`
          : ""
      }
    </div>
  `;

  const nameNode = document.getElementById("profileName");
  if (nameNode) {
    nameNode.textContent = displayName;
  }
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

async function fetchProfile() {
  let response;
  if (isMe) {
    response = await secureFetch("/api/users/me");
  } else {
    if (!paralegalId) {
      throw new Error("Missing paralegal id.");
    }
    response = await secureFetch(`/api/paralegals/${encodeURIComponent(paralegalId)}`);
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error || payload?.msg || "Unable to load profile.");
  }

  return response.json();
}

(async function boot() {
  try {
    const profile = await fetchProfile();
    renderProfile(profile);
  } catch (err) {
    renderError(err?.message);
  }
})();
