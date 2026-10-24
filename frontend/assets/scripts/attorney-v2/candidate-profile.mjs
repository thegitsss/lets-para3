import { node } from "./dom.mjs";
import { availabilityDot } from "./availability-dot.mjs";
import { states } from "./directory-options.mjs";
import { experience, profilePhoto } from "./candidate-model.mjs";

const stateCodes = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const displayState = value => String(value || "").replace(/\b[A-Z]{2}\b/g, code => states[stateCodes.indexOf(code)] || code);
function photo(profile) {
  const image = node("img", { src: profilePhoto(profile.avatarURL || profile.profileImage, profile.id, location.origin), alt: "", width: "64", height: "64", loading: "lazy" });
  image.addEventListener("error", () => { image.src = "/assets/avatar-placeholder.svg"; }, { once: true });
  return image;
}

// The owner preview and attorney profile share this exact presentation.
export function renderCandidateProfile(profile, { actions = null, documents = null, hiring = null } = {}) {
    const intro = node("header", { className: "av2-profile-intro" }, [photo(profile), node("div", {}, [node("div", { className: "av2-profile-name-row" }, [node("h1", { id: "av2-page-title", text: profile.name }), node("div", { className: "av2-profile-name-actions" }, [...availabilityDot(profile)])]), node("p", { className: "av2-muted", text: [displayState(profile.location || profile.state) || "", experience(profile.yearsExperience)].filter(Boolean).join(" · ") })])]);
    intro.querySelectorAll(":scope > div > p").forEach(element => { if (!element.textContent.trim()) element.remove(); });
    const sections = [];
    const sidebar = node("aside", { className: "av2-profile-sidebar", "aria-label": "Profile details and actions" });
    const paragraph = (heading, value, target = sections) => { if (value) { const section = node("section", { className: "av2-profile-section" }, [node("h2", { text: heading }), node("p", { className: "av2-preserve-text", text: value })]); Array.isArray(target) ? target.push(section) : target.append(section); } };
    paragraph("About", profile.bio || profile.about);
    if (profile.bio && profile.about && profile.about !== profile.bio) paragraph("More about this paralegal", profile.about);
    for (const [heading, values] of [["Practice areas", profile.practiceAreas.length ? profile.practiceAreas : profile.specialties], ["Skills", profile.skills], ["States of experience", profile.stateExperience?.length ? profile.stateExperience : profile.jurisdictions], ["Languages", profile.languages]]) paragraph(heading, values?.join(", "), sidebar);
    for (const [heading, records] of [["Experience", profile.experience], ["Education", profile.education]]) {
      const entries = (records || []).filter(item => Object.values(item).some(Boolean)).map(item => {
        const education = heading === "Education";
        const primary = education ? [item.degree, item.fieldOfStudy].filter(Boolean).join(" · ") : item.title;
        const organization = education ? item.school : [item.company, item.firm].filter((value, index, all) => value && all.indexOf(value) === index).join(" · ");
        const dates = education ? [item.startYear, item.endYear].filter(Boolean).join("–") : [item.startDate, item.endDate].filter(Boolean).join(" – ");
        const details = education ? [item.grade && `Grade: ${item.grade}`, item.activities && `Activities: ${item.activities}`] : [item.years, item.description];
        return node("div", { className: "av2-profile-record" }, [
          ...(primary ? [node("p", { className: "av2-profile-record-title", text: primary })] : []),
          ...(organization ? [node("p", { text: organization })] : []),
          ...(dates ? [node("p", { className: "av2-muted", text: dates })] : []),
          ...details.filter(Boolean).map(text => node("p", { className: "av2-preserve-text av2-muted", text })),
        ]);
      });
      if (entries.length) sections.push(node("section", { className: "av2-profile-section" }, [node("h2", { text: heading }), ...entries]));
    }
    try { const url = new URL(profile.linkedInURL); if (url.protocol === "https:" && !url.username && !url.password && (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com"))) sections.push(node("a", { className: "av2-text-link", href: url.href, target: "_blank", rel: "noopener noreferrer", text: "LinkedIn profile" })); } catch { /* No valid LinkedIn profile. */ }
    if (profile.tier === "public") sections.push(node("p", { className: "av2-notice", text: "Public profile preview. Member documents and additional experience are unavailable for this profile." }));
    else if (documents && profile.documents?.length) sidebar.append(documents);
    if (hiring) sidebar.append(hiring);
    return node("div", { className: "lpc-candidate-profile av2-profile-resume" }, [intro, node("div", { className: "av2-profile-columns" }, [actions, node("div", { className: "av2-profile-content" }, sections), sidebar])]);
}
