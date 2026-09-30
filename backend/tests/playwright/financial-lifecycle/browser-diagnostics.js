// WebKit reports some fetches started while a document is departing as native
// JavaScript console errors. Playwright forwards those as pageerror even when
// the document has no error/unhandledrejection event. Keep the raw observations;
// account only for the exact document departures reproduced in these journeys.
function inspectBrowserDiagnostics({ engine, origin, paralegalOwnerId, attorneyOwnerId, errors, events }) {
  const documentFailures = events.filter(event => ["windowerror", "unhandledrejection"].includes(event.type));
  const departureFetchDiagnostics = [], unexplainedPageErrors = [];
  for (const error of errors) {
    let departure = null;
    try {
      const line = String(error.stack || "").split("\n")[0];
      const match = /^Fetch API cannot load (http:\/\/[^\s]+) due to access control checks\.$/.exec(line);
      if (engine !== "webkit" || error.name !== "Fetch API cannot load http" || !match) throw Error("unrecognized diagnostic");
      const request = new URL(match[1]), page = new URL(error.page);
      if (request.origin !== origin || page.origin !== origin) throw Error("unrelated origin");
      let matchesDestination, diagnosticBeforeNavigation = false;
      if (error.role === "paralegal" && page.pathname === "/dashboard-paralegal.html" && page.hash === "#cases") {
        const applicationId = page.searchParams.get("applicationId");
        if (!/^[a-f0-9]{24}$/.test(applicationId || "")) throw Error("unrelated transition");
        if (request.pathname === "/api/auth/me") {
          if (request.search) throw Error("unexpected auth request");
        } else if (request.pathname === "/api/cases/my-completed") {
          if (!/^[a-f0-9]{24}$/.test(paralegalOwnerId || "") || request.searchParams.get("expectedOwnerId") !== paralegalOwnerId || request.searchParams.get("limit") !== "100" || [...request.searchParams.keys()].sort().join(",") !== "expectedOwnerId,limit") throw Error("unrelated history request");
        } else throw Error("unrelated request");
        matchesDestination = next => next.pathname === "/paralegal-v2.html" && next.hash.split("?")[0] === "#/work" && new URLSearchParams(next.hash.split("?")[1]).get("applicationId") === applicationId;
      } else if (error.role === "attorney" && page.pathname === "/dashboard-attorney.html" && page.search === "?archivedPage=6" && page.hash === "#cases:archived") {
        if (!/^[a-f0-9]{24}$/.test(attorneyOwnerId || "") || request.pathname !== "/api/auth/me" || request.search) throw Error("unrelated inventory owner read");
        // Reproduced when the actual Home refresh is interrupted by reload.
        // Both reported fetches are read-only owner checks from that refresh;
        // a matching URL without those callers is not departure evidence.
        const frames = String(error.stack || "").split("\n");
        const hasFrame = (name, pathname, search = "") => frames.some(frame => {
          const match = /^\s*at ([a-zA-Z]+) \((http:\/\/[^\s]+)\)$/.exec(frame);
          if (!match || match[1] !== name) return false;
          const source = new URL(match[2].replace(/:\d+:\d+$/, ""));
          return source.origin === origin && source.pathname === pathname && source.search === search && !source.hash;
        });
        if (!hasFrame("verifyCaseNoteOwner", "/assets/scripts/attorney-tabs.js", "?v=20260905-matter-notes") || !hasFrame("refreshApplicationsOverview", "/assets/scripts/attorney-tabs.js", "?v=20260905-matter-notes") || !hasFrame("load", "/assets/scripts/utils/current-draft-inventory.mjs")) throw Error("unrelated inventory operation");
        matchesDestination = next => next.href === page.href;
      } else if (error.role === "attorney" && page.pathname === "/attorney-v2.html" && !page.search) {
        const financials = /^#\/matters\/([a-f0-9]{24})\/financials$/.exec(page.hash);
        if (!financials) throw Error("unrelated financial document");
        if (request.pathname === "/api/auth/me") {
          if (request.search) throw Error("unexpected auth request");
        } else if (["/api/notifications/page", "/api/notifications/unread-count"].includes(request.pathname)) {
          const paged = request.pathname.endsWith("/page");
          if (!/^[a-f0-9]{24}$/.test(attorneyOwnerId || "") || request.searchParams.get("expectedOwnerId") !== attorneyOwnerId || [...request.searchParams.keys()].sort().join(",") !== (paged ? "expectedOwnerId,limit" : "expectedOwnerId") || paged && request.searchParams.get("limit") !== "100") throw Error("unrelated notification request");
        } else throw Error("unrelated financial request");
        matchesDestination = next => next.href === page.href || next.pathname === "/case-detail.html" && !next.hash && next.searchParams.get("caseId") === financials[1] && next.searchParams.get("tab") === "financials" && [...next.searchParams.keys()].sort().join(",") === "caseId,tab";
      } else if (error.role === "paralegal" && page.pathname === "/paralegal-v2.html" && !page.search && page.hash === "#/settings") {
        if (!/^[a-f0-9]{24}$/.test(paralegalOwnerId || "")) throw Error("unverified Settings owner");
        if (request.pathname === "/api/auth/me") {
          if (request.search) throw Error("unexpected Settings auth request");
        } else if (request.pathname === "/api/users/me/onboarding") {
          // This URL also accepts writes. Only the captured start() read in the
          // onboarding controller is part of the observed departing document.
          const readFrame = String(error.stack || "").split("\n").some(frame => {
            const match = /^\s*at start \((http:\/\/[^\s]+)\)$/.exec(frame);
            if (!match) return false;
            const source = new URL(match[1]);
            return source.origin === origin && !source.search && /^\/assets\/scripts\/paralegal-v2\/onboarding-controller\.mjs:\d+:\d+$/.test(source.pathname);
          });
          if (request.search || !readFrame) throw Error("unrelated onboarding operation");
        } else if (["/api/notifications/page", "/api/notifications/unread-count"].includes(request.pathname)) {
          const paged = request.pathname.endsWith("/page");
          if (request.searchParams.get("expectedOwnerId") !== paralegalOwnerId || [...request.searchParams.keys()].sort().join(",") !== (paged ? "expectedOwnerId,limit" : "expectedOwnerId") || paged && request.searchParams.get("limit") !== "100") throw Error("unrelated Settings notification request");
        } else throw Error("unrelated Settings request");
        matchesDestination = next => next.href === page.href;
      } else if (error.role === "paralegal" && page.pathname === "/paralegal-v2.html" && !page.search && page.hash === "#/work?section=invitations") {
        if (!/^[a-f0-9]{24}$/.test(paralegalOwnerId || "")) throw Error("unverified Work owner");
        // The captured six reads belong to loadSnapshot's read-only bundle.
        // In particular, dashboard-views also accepts writes elsewhere; its
        // URL alone is not evidence that this diagnostic came from a read.
        const snapshotRead = String(error.stack || "").split("\n").some(frame => {
          const match = /^\s*at loadSnapshot \((http:\/\/[^\s]+)\)$/.exec(frame);
          if (!match) return false;
          const source = new URL(match[1]);
          return source.origin === origin && !source.search && /^\/assets\/scripts\/paralegal-v2\/work-view\.mjs:\d+:\d+$/.test(source.pathname);
        });
        if (!snapshotRead) throw Error("unrelated Work operation");
        const keys = [...request.searchParams.keys()].sort().join(",");
        if (request.pathname === "/api/paralegal/dashboard") {
          if (keys !== "expectedOwnerId" || request.searchParams.get("expectedOwnerId") !== paralegalOwnerId) throw Error("unrelated Work dashboard");
        } else if (request.pathname === "/api/cases/my-completed") {
          if (keys !== "expectedOwnerId,limit,reviewContexts" || request.searchParams.get("expectedOwnerId") !== paralegalOwnerId || request.searchParams.get("limit") !== "100" || request.searchParams.get("reviewContexts") !== "1") throw Error("unrelated Work history");
        } else if (request.pathname === "/api/account/dashboard-views") {
          if (keys !== "scope" || request.searchParams.get("scope") !== "paralegal_applications") throw Error("unrelated Work views");
        } else if (["/api/applications/my", "/api/cases/invited-to", "/api/payments/connect/status"].includes(request.pathname)) {
          if (request.search) throw Error("unexpected Work read query");
        } else throw Error("unrelated Work request");
        matchesDestination = next => next.pathname === "/browse-jobs.html" && !next.search && !next.hash;
        // Native pageerror delivery can follow the departing document's
        // pagehide report. The captured Work reads still precede the actual
        // Browse navigation; require that boundary and every departure proof.
        diagnosticBeforeNavigation = true;
      } else if (error.role === "paralegal" && page.pathname === "/paralegal-v2.html" && !page.search) {
        const files = /^#\/matter\/([a-f0-9]{24})\?tab=files$/.exec(page.hash);
        if (!files) throw Error("unrelated files document");
        if (request.pathname === "/api/auth/me") {
          if (request.search) throw Error("unexpected auth request");
        } else if (request.pathname === `/api/uploads/case/${files[1]}`) {
          if (request.searchParams.get("presentation") !== "matter" || [...request.searchParams.keys()].join(",") !== "presentation") throw Error("unrelated files request");
        } else if (["/api/notifications/page", "/api/notifications/unread-count"].includes(request.pathname)) {
          const paged = request.pathname.endsWith("/page");
          if (!/^[a-f0-9]{24}$/.test(paralegalOwnerId || "") || request.searchParams.get("expectedOwnerId") !== paralegalOwnerId || [...request.searchParams.keys()].sort().join(",") !== (paged ? "expectedOwnerId,limit" : "expectedOwnerId") || paged && request.searchParams.get("limit") !== "100") throw Error("unrelated notification request");
        } else throw Error("unrelated files request");
        matchesDestination = next => next.href === page.href;
      } else throw Error("unrelated document");
      const relevant = events.filter(event => event.role === error.role);
      for (const before of relevant.filter(event => event.type === "beforeunload" && event.page === error.page && event.documentId && event.at <= error.at && error.at - event.at <= 1000)) {
        const hide = relevant.find(event => event.type === "pagehide" && event.documentId === before.documentId && event.page === error.page && event.at >= (diagnosticBeforeNavigation ? before.at : error.at) && event.at - before.at <= 1000 && event.persisted === false);
        if (!hide) continue;
        const navigation = relevant.find(event => {
          if (event.type !== "navigation" || event.at < hide.at || event.at - hide.at > 1000 || diagnosticBeforeNavigation && event.at < error.at) return false;
          const next = new URL(event.page);
          return next.origin === origin && matchesDestination(next);
        });
        if (!navigation) continue;
        const shown = relevant.find(event => event.type === "pageshow" && event.page === navigation.page && event.documentId && event.documentId !== before.documentId && event.at >= navigation.at && event.at - navigation.at <= 10000);
        if (!shown) continue;
        departure = { error, request: request.pathname, departingDocumentId: before.documentId, nextDocumentId: shown.documentId, millisecondsAfterBeforeUnload: error.at - before.at };
        break;
      }
    } catch { /* An unknown or malformed observation remains a failing error. */ }
    if (departure) departureFetchDiagnostics.push(departure);
    else unexplainedPageErrors.push(error);
  }
  return { documentFailures, unexplainedPageErrors, departureFetchDiagnostics };
}
module.exports = inspectBrowserDiagnostics;
