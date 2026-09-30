import { adaptLegacyDestination } from "./deep-links.mjs";
import { verifyParalegalSession } from "./session-boundary.mjs";
import { createWorkspaceSearch } from "../utils/workspace-search.mjs";

const COMMANDS = Object.freeze([
  { label: "Home", href: "/paralegal-v2.html#/home", keywords: "dashboard overview office" },
  { label: "Browse Matters", href: "/paralegal-v2.html#/browse", keywords: "jobs opportunities find work" },
  { label: "My Matters & Applications", href: "/paralegal-v2.html#/work", keywords: "active completed applications invitations" },
  { label: "History", href: "/paralegal-v2.html#/work?section=history", keywords: "past matters archive history payouts receipts" },
  { label: "Profile Settings", href: "/paralegal-v2.html#/settings?tab=profile", recentAliases: ["/paralegal-v2.html#/settings"], keywords: "resume bio photo skills" },
  { label: "Security settings", href: "/paralegal-v2.html#/settings?tab=security", keywords: "password sessions two factor mfa stripe" },
  { label: "Preferences", href: "/paralegal-v2.html#/settings?tab=preferences", keywords: "notifications appearance accessibility theme" },
  { label: "Help", href: "/paralegal-v2.html#/help", keywords: "support report issue guidance" },
]);

export function createSearchController(options) {
  return createWorkspaceSearch({
    ...options, commands: COMMANDS, types: ["matter"], prefix: "v2-search", inline: true, routeAttribute: "data-v2-route",
    verifySession: request => verifyParalegalSession(options.api, request),
    destinationFor: row => {
      try {
        const url = new URL(row.nextAction.href, location.origin);
        if (url.origin !== location.origin || !["/case-detail.html", "/browse-jobs.html"].includes(url.pathname) || url.searchParams.get("caseId") !== row.id || url.username || url.password) return null;
        return adaptLegacyDestination(row.nextAction.href, { caseId: row.id });
      } catch { return null; }
    },
  });
}
