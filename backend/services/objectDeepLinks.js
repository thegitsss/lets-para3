const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const MATTER_TABS = new Set([
  "overview",
  "applications",
  "work",
  "files",
  "messages",
  "activity",
  "financials",
]);

function normalizeId(value) {
  const id = String(value?._id || value?.id || value || "").trim();
  return OBJECT_ID_PATTERN.test(id) ? id : "";
}

function encodeId(value) {
  const id = normalizeId(value);
  return id ? encodeURIComponent(id) : "";
}

function buildMatterLink({ caseId, tab = "overview", applicantId, fileId, messageId } = {}) {
  const safeCaseId = encodeId(caseId);
  const safeTab = String(tab || "overview").toLowerCase();
  if (!safeCaseId || !MATTER_TABS.has(safeTab)) return "";
  const params = new URLSearchParams({ caseId: safeCaseId, tab: safeTab });
  if (safeTab === "applications") {
    const safeApplicantId = normalizeId(applicantId);
    if (safeApplicantId) params.set("applicantId", safeApplicantId);
  }
  if (safeTab === "files") {
    const safeFileId = normalizeId(fileId);
    if (safeFileId) params.set("fileId", safeFileId);
  }
  if (safeTab === "messages") {
    const safeMessageId = normalizeId(messageId);
    if (safeMessageId) params.set("messageId", safeMessageId);
  }
  return `/case-detail.html?${params.toString()}`;
}

function buildObjectDeepLink(object = {}) {
  const type = String(object.type || "").trim().toLowerCase();
  if (type === "matter_review") {
    const caseId = encodeId(object.caseId), disputeId = String(object.disputeId || "");
    if (!caseId || !["attorney", "paralegal", "admin"].includes(object.role) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(disputeId)) return "";
    if (object.role === "admin") return `/admin-dashboard.html?review=${encodeURIComponent(disputeId)}&reviewMatter=${caseId}#finance`;
    if (object.role === "paralegal" && object.retained) return buildObjectDeepLink({ type: "completed_matter", caseId, role: object.role });
    return buildMatterLink({ caseId, tab: "financials" });
  }
  if (type === "matter") return buildMatterLink({ caseId: object.caseId, tab: object.tab || "overview" });
  if (type === "application") {
    return buildMatterLink({ caseId: object.caseId, tab: "applications", applicantId: object.applicantId });
  }
  if (type === "retained_application") {
    const caseId = encodeId(object.caseId), applicantId = encodeId(object.applicantId);
    return caseId && applicantId ? `/dashboard-attorney.html?caseId=${caseId}&applicantId=${applicantId}&openApplicant=1&applicationHistory=1#cases:inquiries` : "";
  }
  if (type === "file") {
    return buildMatterLink({ caseId: object.caseId, tab: "files", fileId: object.fileId });
  }
  if (type === "message") {
    return buildMatterLink({ caseId: object.caseId, tab: "messages", messageId: object.messageId });
  }
  if (type === "financials") return buildMatterLink({ caseId: object.caseId, tab: "financials" });
  if (type === "profile") {
    const profileId = encodeId(object.profileId || object.paralegalId);
    return profileId ? `/profile-paralegal.html?paralegalId=${profileId}` : "";
  }
  if (type === "invitation") {
    const caseId = encodeId(object.caseId);
    return caseId ? `/dashboard-paralegal.html?inviteCase=${caseId}#home` : "";
  }
  if (type === "paralegal_application") {
    const applicationId = encodeId(object.applicationId);
    const jobId = encodeId(object.jobId);
    return applicationId ? `/dashboard-paralegal.html?applicationId=${applicationId}#cases` : jobId ? `/dashboard-paralegal.html?jobId=${jobId}#cases` : "";
  }
  if (type === "completed_matter") {
    const caseId = encodeId(object.caseId);
    const role = String(object.role || "").toLowerCase();
    if (!caseId || !["attorney", "paralegal"].includes(role)) return "";
    return role === "attorney"
      ? `/dashboard-attorney.html?highlightCase=${caseId}#cases:archived`
      : `/dashboard-paralegal.html?highlightCase=${caseId}#cases-completed`;
  }
  if (type === "profile_settings") return "/profile-settings.html";
  return "";
}

function parseMatterDeepLink(value = "") {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || raw.includes("\\")) return null;
  let url;
  try {
    url = new URL(raw, "https://lpc.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://lpc.invalid" || url.pathname !== "/case-detail.html") return null;
  const caseId = normalizeId(url.searchParams.get("caseId"));
  if (!caseId) return null;
  let tab = String(url.searchParams.get("tab") || "overview").toLowerCase();
  if (!url.searchParams.get("tab") && url.hash === "#case-messages") tab = "messages";
  if (!url.searchParams.get("tab") && url.hash === "#caseFilesSection") tab = "files";
  if (!MATTER_TABS.has(tab)) tab = "overview";
  return {
    caseId,
    tab,
    applicantId: tab === "applications" ? normalizeId(url.searchParams.get("applicantId")) : "",
    fileId: tab === "files" ? normalizeId(url.searchParams.get("fileId")) : "",
    messageId: tab === "messages" ? normalizeId(url.searchParams.get("messageId")) : "",
  };
}

module.exports = {
  MATTER_TABS,
  buildMatterLink,
  buildObjectDeepLink,
  normalizeId,
  parseMatterDeepLink,
};
