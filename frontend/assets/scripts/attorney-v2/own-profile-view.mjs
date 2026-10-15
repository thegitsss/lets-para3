import { node, page, link, button } from "./dom.mjs";
import { accountPhoto } from "./account-api.mjs";

const texts = values => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))] : [];
function httpLink(value, label) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? node("a", { href: url.href, target: "_blank", rel: "noopener noreferrer", text: label }) : null; } catch { return null; }
}
function section(title, children) { return children.length ? node("section", { className: "av2-public-section" }, [node("h2", { text: title }), ...children]) : null; }
export function createOwnProfileView(_route, identity, { accountApi, signal } = {}) {
  const view = page("Your profile", "As paralegals see it.");
  view.classList.add("av2-account");
  view.firstChild.append(link("Edit profile", "#/settings"));
  const content = node("div", { "data-account-preview": "" }), status = node("p", { role: "status", className: "av2-muted", text: "Loading profile…" });
  const retry = button("Try again", () => { view.readiness = load(); }); retry.hidden = true;
  view.append(status, retry, content);
  async function load() {
    retry.hidden = true; status.textContent = "Loading profile…"; content.replaceChildren();
    try {
      const profile = await accountApi.readPublicProfile({ ownerId: identity.id, signal }); if (signal.aborted) return;
      const name = profile.name.trim() || "Attorney", photo = accountPhoto(profile.profileImage, identity.id);
      const avatar = node("div", { className: "av2-public-photo" });
      const initials = node("span", { text: [profile.firstName, profile.lastName].map(v => String(v || "").slice(0,1)).join("").toUpperCase() || "A", "aria-hidden": "true" });
      avatar.append(initials);
      if (photo) { const image = node("img", { src: photo, alt: `Profile photo for ${name}` }); image.addEventListener("load", () => { initials.hidden = true; }); image.addEventListener("error", () => { image.remove(); initials.hidden = false; }); avatar.append(image); }
      const metadata = [profile.lawFirm, profile.location, Number(profile.yearsExperience) > 0 ? `${profile.yearsExperience} years of experience` : ""].filter(Boolean);
      const header = node("header", { className: "av2-public-header" }, [avatar, node("div", {}, [node("h2", { text: name }), ...(metadata.length ? [node("p", { className: "av2-muted", text: metadata.join(" · ") })] : [])])]);
      const links = [httpLink(profile.firmWebsite, "Firm website"), httpLink(profile.linkedInURL, "LinkedIn")].filter(Boolean);
      if (links.length) header.lastChild.append(node("div", { className: "av2-actions" }, links));
      const sections = [
        section("About", profile.practiceDescription ? [node("p", { text: profile.practiceDescription })] : []),
        section("Practice areas", texts([...(profile.practiceAreas || []), ...(profile.specialties || [])]).map(text => node("span", { className: "av2-account-chip", text }))),
        section("Experience", (Array.isArray(profile.experience) ? profile.experience : []).map(entry => typeof entry === "string" ? node("p", { text: entry }) : node("article", {}, [node("h3", { text: entry.title || entry.role || "Experience" }), ...(entry.years ? [node("p", { className: "av2-muted", text: entry.years })] : []), ...(entry.description ? [node("p", { text: entry.description })] : [])]))),
        section("Languages", (Array.isArray(profile.languages) ? profile.languages : []).map(entry => node("p", { text: typeof entry === "string" ? entry : [entry.name, entry.proficiency].filter(Boolean).join(" · ") }))),
        section("Publications", texts(profile.publications).map(text => node("p", { text }))),
      ].filter(Boolean);
      content.append(header, ...sections); status.textContent = "";
      if (!sections.length) content.append(node("p", { className: "av2-muted", text: "Add your professional details in Profile Settings." }));
    } catch (error) {
      if (signal.aborted || error.name === "AbortError") return;
      status.textContent = [403,404].includes(error.status) ? "Your public profile is unavailable to this account." : "Your profile couldn’t load."; retry.hidden = false;
    }
  }
  view.readiness = load(); return view;
}
