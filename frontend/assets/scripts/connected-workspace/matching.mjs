import { node, notice, input, createClient, showFatal, validId } from "./shared.mjs";
const main = document.querySelector("main"), content = document.querySelector("[data-content]"), status = document.querySelector("[data-status]");
let client, busy = false;
try {
  client = await createClient(["attorney"]);
  const query = input("Describe the work", { multiline: true, rows: "4", maxlength: "1500", placeholder: "For example: preparing discovery responses and organizing exhibits, with Clio experience." });
  const years = input("Minimum years of experience", { type: "number", min: "0", max: "80", value: "0" });
  const skills = input("Required profile skills (optional)", { type: "text", maxlength: "500", placeholder: "Separate exact skill names with commas" });
  const available = node("input", { type: "checkbox" });
  const filters = node("div", { className: "cw-search-filters" }, [years.element, skills.element, node("label", { className: "cw-inline-check" }, [available, node("span", { text: "Show currently available profiles" })])]);
  const results = node("section", { "aria-label": "Matching paralegals", "aria-live": "polite" });
  const submit = node("button", { type: "submit", className: "cw-button", text: "Find relevant paralegals" });
  const form = node("form", { className: "cw-card" }, [query.element, filters, notice("Required skills filter exact self-reported profile skills. Profile evidence does not independently verify a qualification."), submit]);
  content.replaceChildren(form, results);
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return;
    if (query.control.value.trim().length < 3) { status.textContent = "Describe the work in at least three characters."; query.control.focus(); return; }
    busy = true; submit.disabled = true; main.setAttribute("aria-busy", "true"); status.textContent = "Finding relevant profile evidence…";
    results.replaceChildren();
    try {
      const caseId = new URLSearchParams(location.search).get("caseId");
      const data = await client.write("/api/paralegal-matching/search", { query: query.control.value.trim(), minimumYears: Number(years.control.value), availableOnly: available.checked, requiredSkills: skills.control.value.split(",").map(value => value.trim()).filter(Boolean), ...(validId(caseId) ? { caseId } : {}) });
      status.textContent = data.totalShown + " relevant profiles · " + (data.mode === "semantic_and_profile_evidence" ? "Meaning and profile evidence" : "Profile evidence");
      results.append(notice(data.requirementsNotice));
      if (data.note) results.append(notice(data.note));
      if (!data.items.length) results.append(node("section", { className: "cw-card" }, [node("h2", { text: "No relevant profiles found" }), node("p", { text: "Try describing the work differently or relaxing the filters. Your current filters are still shown above." })]));
      for (const person of data.items) {
        const card = node("article", { className: "cw-card cw-match" }, [node("div", { className: "cw-section-title" }, [node("h2", { text: person.name }), node("span", { className: "cw-tag", text: person.availability })]), node("p", { className: "cw-muted", text: [person.location, person.yearsExperience !== null ? person.yearsExperience + " years of experience" : ""].filter(Boolean).join(" · ") }), node("h3", { text: person.matchBasis })]);
        card.append(...person.evidence.map(row => node("div", { className: "cw-observation" }, [node("span", { className: "cw-label", text: row.field + " · Self-reported" }), node("blockquote", { text: row.text })])));
        if (person.requirements.length) card.append(node("details", {}, [node("summary", { text: "Matter requirements still require confirmation" }), ...person.requirements.map(row => node("p", { text: row.text }))]));
        card.append(node("p", { className: "cw-muted", text: person.availabilityNote }), node("a", { className: "cw-secondary", href: person.profileHref, text: "Review profile" }));
        results.append(card);
      }
    } catch (error) { status.textContent = error.message; results.replaceChildren(notice("Search was not completed. Your request is still available above; try again.", true)); }
    finally { busy = false; submit.disabled = false; main.setAttribute("aria-busy", "false"); }
  });
  window.addEventListener("lpc-connected-access-lost", () => { results.replaceChildren(); query.control.value = ""; skills.control.value = ""; });
  status.textContent = "Search the approved paralegal directory by the work you need.";
} catch (error) { showFatal(error); }
