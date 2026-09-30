import { LpcApiError } from "./api-client.mjs";
import { objectId } from "./deep-links.mjs";

function node(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (name === "className") element.className = value;
    else if (name === "text") element.textContent = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  });
  children.flat().filter(Boolean).forEach((child) => element.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return element;
}

function list(value) {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))] : [];
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function profilePhoto(value) {
  const url = String(value || "").trim();
  return /^\/api\/users\/profile-photo\/[a-f\d]{24}(?:\?|$)/i.test(url) ? url : "";
}

function initials(profile) {
  return [profile?.firstName, profile?.lastName].filter(Boolean).slice(0, 2).map((part) => String(part).charAt(0).toUpperCase()).join("") || "A";
}

function profileName(profile) {
  return String(profile?.name || [profile?.firstName, profile?.lastName].filter(Boolean).join(" ") || "Attorney").trim();
}

function routeLink(label, path) {
  return node("a", { className: "v2-settings-secondary", href: `paralegal-v2.html#${path}`, "data-view": path, "data-v2-route": "", text: label });
}

function section(title, content) {
  if (!content?.length) return null;
  return node("section", { className: "v2-settings-preview-section" }, [node("h2", { text: title }), ...content]);
}

function chipSection(title, values) {
  const items = list(values);
  return section(title, items.length ? [node("div", { className: "v2-settings-chips" }, items.map((item) => node("span", { className: "v2-settings-chip", text: item })))] : []);
}

function experienceItems(values) {
  if (!Array.isArray(values)) return [];
  return values.filter(Boolean).slice(0, 8).map((entry) => {
    if (typeof entry === "string") return node("article", {}, [node("strong", { text: entry })]);
    return node("article", {}, [
      node("strong", { text: entry.title || entry.role || "Experience" }),
      entry.years ? node("span", { text: entry.years }) : null,
      entry.description ? node("p", { text: entry.description }) : null,
    ]);
  });
}

function languageText(values) {
  if (!Array.isArray(values)) return "";
  return values.map((entry) => typeof entry === "string" ? entry : [entry?.name, entry?.proficiency].filter(Boolean).join(" — ")).filter(Boolean).join(" · ");
}

function profileView(profile) {
  const name = profileName(profile);
  const photo = profilePhoto(profile.profileImage || profile.avatarURL);
  const linkedIn = safeHttpUrl(profile.linkedInURL);
  const website = safeHttpUrl(profile.firmWebsite || profile.website);
  const practiceAreas = [...list(profile.practiceAreas), ...list(profile.specialties)];
  const subtitle = [
    Number(profile.yearsExperience) > 0 ? `${profile.yearsExperience} year${Number(profile.yearsExperience) === 1 ? "" : "s"} of experience` : "",
    profile.lawFirm,
    profile.location,
  ].filter(Boolean).join(" · ");
  const links = [
    linkedIn ? node("a", { href: linkedIn, target: "_blank", rel: "noopener noreferrer", text: "LinkedIn" }) : null,
    website ? node("a", { href: website, target: "_blank", rel: "noopener noreferrer", text: "Firm website" }) : null,
  ].filter(Boolean);

  return node("section", { className: "v2-settings-preview v2-attorney-profile", "data-v2-attorney-profile": "" }, [
    node("header", { className: "v2-settings-preview-header" }, [
      node("div", {}, [node("p", { className: "v2-settings-preview-kicker", text: "Matter attorney" }), node("h1", { text: name }), subtitle ? node("p", { text: subtitle }) : null]),
      routeLink("Back to Browse Matters", "/browse"),
    ]),
    node("div", { className: "v2-settings-preview-layout" }, [
      node("aside", {}, [
        photo ? node("img", { src: photo, alt: `Profile photo for ${name}` }) : node("span", { className: "v2-settings-preview-initials", text: initials(profile) }),
        ...links,
      ]),
      node("div", {}, [
        profile.practiceDescription ? section("About", [node("p", { text: profile.practiceDescription })]) : null,
        chipSection("Practice areas", practiceAreas),
        section("Experience", experienceItems(profile.experience)),
        languageText(profile.languages) ? section("Languages", [node("p", { text: languageText(profile.languages) })]) : null,
        chipSection("Publications", profile.publications),
      ]),
    ]),
  ]);
}

function stateView(kind) {
  const content = {
    invalid: ["Profile link unavailable", "This attorney profile address is incomplete or invalid."],
    unavailable: ["Profile temporarily unavailable", "This attorney profile could not be loaded right now."],
    forbidden: ["Profile unavailable", "This attorney profile is not available to your account."],
    missing: ["Profile not found", "This attorney profile may no longer be available."],
  }[kind] || ["Profile temporarily unavailable", "This attorney profile could not be loaded right now."];
  return node("section", { className: "v2-matter-state", "aria-labelledby": "v2-attorney-profile-state-title" }, [
    node("h1", { id: "v2-attorney-profile-state-title", text: content[0] }),
    node("p", { text: content[1] }),
    routeLink("Back to Browse Matters", "/browse"),
  ]);
}

export function createAttorneyProfileView({ api, onSessionLost } = {}) {
  let controller = null;
  async function render({ route, isCurrent } = {}) {
    controller?.abort();
    const id = objectId(route?.params?.attorneyId);
    if (!id) return stateView("invalid");
    controller = new AbortController();
    try {
      const profile = await api.get(`/api/users/attorneys/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!isCurrent() || controller.signal.aborted) return null;
      return profileView(profile);
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrent()) return null;
      if (error instanceof LpcApiError && error.status === 401) {
        onSessionLost?.();
        return stateView("forbidden");
      }
      if (error instanceof LpcApiError && error.status === 403) return stateView("forbidden");
      if (error instanceof LpcApiError && error.status === 404) return stateView("missing");
      return stateView("unavailable");
    }
  }
  return Object.freeze({ render, leave: () => controller?.abort() });
}
