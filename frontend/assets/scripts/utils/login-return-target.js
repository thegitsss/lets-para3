(function (root) {
  const paralegalPages = new Set([
    "/dashboard-paralegal.html", "/case-detail.html", "/browse-jobs.html",
    "/profile-settings.html", "/profile-paralegal.html", "/profile-attorney.html", "/help.html", "/paralegalhelp.html",
  ]);
  const attorneyPages = new Set([
    "/dashboard-attorney.html", "/create-case.html", "/case-detail.html", "/case-applications.html",
    "/browse-paralegals.html", "/profile-paralegal.html", "/profile-attorney.html",
    "/profile-settings.html", "/help.html", "/attorney-faq.html", "/contact.html",
  ]);
  function resolve(requested, role, origin = "https://lpc.invalid") {
    const memberRole = String(role || "").toLowerCase();
    if (!["attorney", "paralegal"].includes(memberRole) || typeof requested !== "string" || requested.length > 16000) return "";
    try {
      if (/[\\\u0000-\u001f]/.test(requested)) return "";
      const target = new URL(requested, origin);
      if (target.origin !== new URL(origin).origin || target.username || target.password) return "";
      if (memberRole === "paralegal" && target.pathname === "/paralegal-v2.html") {
        if (target.search || (target.hash && !/^#\/(?:home|browse|work|settings|help|profile(?:\/[^/?#]+)?|attorney\/[^/?#]+|matter\/[^/?#]+)(?:\?.*)?$/.test(target.hash))) return "";
        return `${target.pathname}${target.hash || "#/home"}`;
      }
      if (memberRole === "attorney" && target.pathname === "/attorney-v2.html") {
        if (target.search || (target.hash && !/^#\/(?:home|matters(?:\/(?:new|[a-f\d]{24}\/(?:overview|applications|invitations|manage|work|files|messages|deadlines|activity|financials|receipt|export|archive)))?|tasks|paralegals(?:\/[a-f\d]{24})?|payments(?:\/setup)?|settings|help|profile)(?:\?.*)?$/i.test(target.hash))) return "";
        return `${target.pathname}${target.hash || "#/home"}`;
      }
      const pages = memberRole === "attorney" ? attorneyPages : paralegalPages;
      if (!pages.has(target.pathname)) return "";
      return `${target.pathname}${target.search}${target.hash}`;
    } catch (_) { return ""; }
  }
  const api = Object.freeze({ resolve });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LPCLoginReturn = api;
})(globalThis);
