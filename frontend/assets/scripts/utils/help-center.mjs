import { createReportStatusPage, validReportId } from "./report-status.mjs";
import { clearHelpStorage } from "./help-storage.mjs";


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

function compact(value, maximum) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function diagnostics() {
  const userAgent = String(navigator.userAgent || "");
  const browserName = /edg\//i.test(userAgent) ? "Edge"
    : /firefox\//i.test(userAgent) ? "Firefox"
    : /chrome\//i.test(userAgent) ? "Chrome"
    : /safari\//i.test(userAgent) ? "Safari"
    : "Unknown";
  return {
    pageUrl: window.location.href,
    routePath: window.location.pathname,
    userAgent,
    browserName,
    deviceType: /ipad|tablet/i.test(userAgent) ? "tablet" : /iphone|android|mobile/i.test(userAgent) ? "mobile" : "desktop",
    language: navigator.language || "",
    online: navigator.onLine,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    viewport: { width: window.innerWidth || null, height: window.innerHeight || null, devicePixelRatio: window.devicePixelRatio || 1 },
    screen: { width: window.screen?.width || null, height: window.screen?.height || null },
    submittedAt: new Date().toISOString(),
  };
}

function statusMessage(root, tone, title, copy, meta = "") {
  root.hidden = false;
  root.dataset.tone = tone;
  root.replaceChildren(
    node("strong", { text: title }),
    ...(copy ? [node("span", { text: copy })] : []),
    ...(meta ? [node("small", { text: meta })] : [])
  );
}

function storeReporterAccess(incident, token, reporterId) {
  if (!incident?.publicId || !token) return;
  try {
    sessionStorage.setItem(`incident-access:${incident.publicId}`, JSON.stringify({
      publicId: incident.publicId,
      reporterAccessToken: token,
      reporterId,
      storedAt: new Date().toISOString(),
    }));
  } catch {
    // Reporter access remains available through the authenticated account.
  }
}

export function createHelpCenter({ api, openAssistant, getIdentity, onSessionLost, sections, title, introduction, guideLabel, featureKey, resources, getReportContext = () => ({}), routeAttribute = "data-v2-route" } = {}) {
  let view = null;
  let reportView = null;
  let reportRevision = 0;
  let pendingRequest = null;
  let retryPayload = null;
  let draftOwner = "";
  const reportDraft = { summary: "", description: "" };
  const draftKey = (owner) => `lpc:v2:help-draft:${owner}`;
  const identityId = () => String(getIdentity?.()?.id || getIdentity?.()?._id || "");

  function persistDraft() {
    if (!draftOwner) return;
    try {
      if (!reportDraft.summary && !reportDraft.description && !retryPayload) sessionStorage.removeItem(draftKey(draftOwner));
      else sessionStorage.setItem(draftKey(draftOwner), JSON.stringify({ reporterId: draftOwner, ...reportDraft, retryPayload }));
    } catch {
      // In-memory drafts and the existing unfinished-work warning remain usable.
    }
  }

  function restoreDraft() {
    const owner = identityId();
    if (!owner || owner === draftOwner) return;
    draftOwner = owner;
    try {
      const saved = JSON.parse(sessionStorage.getItem(draftKey(owner)) || "null");
      if (!saved || saved.reporterId !== owner) return;
      reportDraft.summary = String(saved.summary || "").slice(0, 180);
      reportDraft.description = String(saved.description || "").slice(0, 5000);
      const pending = saved.retryPayload;
      if (pending?.reporterId === owner && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pending.requestId || "")
        && typeof pending.summary === "string" && pending.summary.length <= 180
        && typeof pending.description === "string" && pending.description.length <= 5000) retryPayload = pending;
    } catch {
      // A malformed or unavailable browser draft is never submitted automatically.
    }
  }

  function articleSection(section) {
    return node("section", { className: "v2-help-article-section", id: `v2-help-${section.id}` }, [
      node("h2", { text: section.title }),
      ...section.answers.map(({ question, answer }) => node("details", { className: "v2-help-answer" }, [
        node("summary", { text: question }), node("p", { text: answer }),
      ])),
    ]);
  }

  function reportPanel() {
    const summary = node("input", {
      id: "v2-help-report-summary",
      name: "summary",
      type: "text",
      maxlength: "180",
      required: true,
      placeholder: "What is not working?",
      value: reportDraft.summary,
    });
    const description = node("textarea", {
      id: "v2-help-report-description",
      name: "description",
      maxlength: "5000",
      required: true,
      rows: "6",
      placeholder: "What did you expect, and what happened instead?",
      text: reportDraft.description,
    });
    const submit = node("button", { className: "v2-help-submit", type: "submit", text: "Submit issue" });
    const status = node("div", { className: "v2-help-report-status", role: "status", "aria-live": "polite", hidden: true });
    const form = node("form", { className: "v2-help-report-form", novalidate: true }, [
      node("div", { className: "v2-help-field" }, [node("label", { for: summary.id, text: "Short summary" }), summary]),
      node("div", { className: "v2-help-field" }, [node("label", { for: description.id, text: "What happened?" }), description]),
      node("p", { className: "v2-help-report-warning", text: "For account or platform problems only. Do not include privileged matter content, documents, passwords, or payment details." }),
      node("div", { className: "v2-help-report-actions" }, [submit]),
      status,
    ]);

    if (retryPayload) {
      submit.textContent = "Check report";
      statusMessage(status, "neutral", "Receipt unconfirmed", "Check the previous submission before sending another report. Your current edits remain in the form.");
    }
    async function send(payload) {
      if (pendingRequest) return;
      const checkingPrevious = Boolean(retryPayload);
      const revision = reportRevision;
      const requestController = new AbortController();
      pendingRequest = requestController;
      retryPayload = payload;
      persistDraft();
      submit.disabled = true;
      statusMessage(status, "neutral", "Sending your report to LPC.", "");
      try {
        const result = await api.post("/api/incidents", payload, { signal: requestController.signal, recovery: checkingPrevious });
        if (revision !== reportRevision) return;
        if (result?.ok !== true || !validReportId(result?.incident?.publicId)) throw new Error("LPC did not confirm receipt. Your report is still in the form.");
        retryPayload = null;
        storeReporterAccess(result?.incident, result?.reporterAccessToken, payload.reporterId);
        const newerEdits = compact(summary.value, 180) !== payload.summary
          || String(description.value || "").trim() !== payload.description;
        if (!newerEdits) {
          summary.value = "";
          description.value = "";
          reportDraft.summary = "";
          reportDraft.description = "";
        }
        persistDraft();
        statusMessage(
          status,
          "success",
          "Report received",
          newerEdits ? "Your newer edits are still in the form." : "",
          `Reference: ${result.incident.publicId}`
        );
        if (validReportId(result.incident.publicId)) status.append(node("a", { href: `#/help?incident=${encodeURIComponent(result.incident.publicId)}`, [routeAttribute]: "help", text: "View report" }));
      } catch (error) {
        if (revision !== reportRevision) return;
        // Validation happens before intake persistence. Network/server failures
        // can hide a committed report, so they retain its original request key.
        retryPayload = error?.dispatched === false && !checkingPrevious || [400, 422].includes(Number(error?.status)) ? null : payload;
        persistDraft();
        const fieldError = error?.payload?.fields && typeof error.payload.fields === "object"
          ? Object.values(error.payload.fields).find(Boolean)
          : "";
        const errorCopy = fieldError || error?.message || "Unable to submit the issue right now.";
        statusMessage(status, "error", retryPayload ? "Receipt unconfirmed" : "Unable to submit", retryPayload
          ? "Try again to check this submission before sending another report. Your current edits remain in the form."
          : errorCopy);
      } finally {
        if (revision === reportRevision) {
          pendingRequest = null;
          submit.disabled = false;
          submit.textContent = retryPayload ? "Try again" : "Submit issue";
        }
      }
    }

    summary.addEventListener("input", () => { reportDraft.summary = summary.value; persistDraft(); });
    description.addEventListener("input", () => { reportDraft.description = description.value; persistDraft(); });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (pendingRequest) return;
      if (retryPayload) { void send(retryPayload); return; }
      const reporterId = identityId();
      if (!reporterId || reporterId !== draftOwner) {
        statusMessage(status, "error", "Account verification needed", "Refresh the page to verify your account before submitting.");
        return;
      }
      const cleanSummary = compact(summary.value, 180);
      const cleanDescription = String(description.value || "").trim().slice(0, 5000);
      if (!cleanSummary || !cleanDescription) {
        statusMessage(status, "error", "More detail needed", "Add both a short summary and a description before submitting.");
        (!cleanSummary ? summary : description).focus();
        return;
      }
      let reportContext;
      try { reportContext = getReportContext(); }
      catch (error) { statusMessage(status, "error", "Related Matter unavailable", error.message); return; }
      const payload = {
        requestId: crypto.randomUUID(),
        reporterId,
        summary: cleanSummary,
        description: cleanDescription,
        pageUrl: window.location.href,
        routePath: window.location.pathname,
        featureKey,
        diagnostics: diagnostics(),
        ...(reportContext.caseId ? { caseId: reportContext.caseId } : {}),
      };
      void send(payload);
    });

    return node("section", { className: "v2-help-report", id: "v2-help-report", "aria-labelledby": "v2-help-report-title" }, [
      node("div", { className: "v2-help-report-copy" }, [
        node("h2", { id: "v2-help-report-title", text: "Report an issue" }),
        node("p", { text: "Tell us what happened. We’ll include basic browser and page information to help investigate." }),
      ]),
      form,
    ]);
  }

  function visitSection(id) {
    const section = document.getElementById(id);
    const heading = section?.querySelector("h2");
    heading?.setAttribute("tabindex", "-1");
    heading?.focus({ preventScroll: true });
    section?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  function build() {
    const directory = node("nav", { className: "v2-help-directory", "aria-label": "Help topics" }, [
      node("p", { text: "In this guide" }),
    ]);
    sections.forEach((section) => {
      const button = node("button", { type: "button", text: section.title });
      button.addEventListener("click", () => visitSection(`v2-help-${section.id}`));
      directory.append(button);
    });
    const reportButton = node("button", { type: "button", text: "Report an issue" });
    reportButton.addEventListener("click", () => visitSection("v2-help-report"));
    directory.append(reportButton);

    const assistantButton = node("button", { className: "v2-help-assistant-button", type: "button", text: "Ask LPC Assistant" });
    const assistantStatus = node("p", { className: "v2-help-assistant-status", role: "status", hidden: true });
    assistantButton.addEventListener("click", async () => {
      assistantButton.disabled = true; assistantStatus.hidden = true;
      try {
        if (typeof openAssistant !== "function" || await openAssistant({ launcher: assistantButton }) === false) throw new Error("unavailable");
      } catch {
        assistantStatus.textContent = "LPC Assistant couldn’t open. Please try again or use Report an issue.";
        assistantStatus.hidden = false;
      } finally { assistantButton.disabled = false; }
    });

    return node("section", { className: "v2-help", "data-v2-help": "", "aria-labelledby": "v2-help-title" }, [
      node("header", { className: "v2-help-heading" }, [
        node("div", {}, [
          node("h1", { id: "v2-help-title", text: title }),
          node("p", { text: introduction }),
        ]),
        node("div", { className: "v2-help-assistant-actions" }, [assistantButton, assistantStatus]),
      ]),
      node("div", { className: "v2-help-layout" }, [
        directory,
        node("div", { className: "v2-help-content" }, [
          node("article", { className: "v2-help-article", "aria-label": guideLabel }, sections.map(articleSection)),
          reportPanel(),
          node("section", { className: "v2-help-resources", "aria-labelledby": "v2-help-resources-title" }, [
            node("h2", { id: "v2-help-resources-title", text: "Resources" }),
            node("div", { className: "v2-help-resource-links" }, [
              ...resources.map(resource => node("a", { href: resource.href, text: resource.label })),
            ]),
          ]),
        ]),
      ]),
    ]);
  }

  return Object.freeze({
    hasDrafts() {
      return Boolean(pendingRequest || retryPayload || reportDraft.summary.trim() || reportDraft.description.trim());
    },
    clearDrafts({ preserveStorage = false } = {}) {
      reportView?.dispose();
      reportView = null;
      reportRevision += 1;
      pendingRequest?.abort();
      pendingRequest = null;
      retryPayload = null;
      if (!preserveStorage) clearHelpStorage();
      draftOwner = "";
      reportDraft.summary = "";
      reportDraft.description = "";
      view = null;
    },
    leave() { reportView?.dispose(); reportView = null; },
    render({ route, isCurrent } = {}) {
      reportView?.dispose();
      reportView = null;
      if (route?.query.has("incident")) {
        reportView = createReportStatusPage(route.query.get("incident"), { api, identity: getIdentity?.(), isCurrent, onSessionLost, routeAttribute });
        return reportView;
      }
      restoreDraft();
      if (!view) view = build();
      return view;
    },
  });
}
