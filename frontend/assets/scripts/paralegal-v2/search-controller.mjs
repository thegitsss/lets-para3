import {shortcutPage} from "../utils/frequent-shortcuts.mjs";
import { adaptLegacyDestination } from "./deep-links.mjs";
import { verifyParalegalSession } from "./session-boundary.mjs";
import { createWorkspaceSearch } from "../utils/workspace-search.mjs";

const COMMANDS = Object.freeze([
  {label:"Pin current page",href:"/paralegal-v2.html#",keywords:"favorite bookmark shortcut",available:()=>Boolean(shortcutPage('paralegal',location.hash)),onSelect:()=>document.dispatchEvent(new CustomEvent('lpc-shortcut-pin-current'))},
  {label:"View applications",href:"/paralegal-v2.html#/work?section=applications",keywords:"pending applications jobs"},
  {label:"Review invitations",href:"/paralegal-v2.html#/work?section=invitations",keywords:"invitations offers"},
  {label:"Updates",href:"/paralegal-v2.html#/updates",keywords:"activity notifications news"},
  { label: "Home", href: "/paralegal-v2.html#/home", keywords: "dashboard overview office" },
  { label: "Browse Matters", href: "/paralegal-v2.html#/browse", keywords: "jobs opportunities find work" },
  { label: "Matters", href: "/paralegal-v2.html#/work", keywords: "active completed applications invitations" },
  { label: "Messages", href: "/paralegal-v2.html#/conversations", keywords: "messages inbox conversations chats" },
  { label: "Payouts", href: "/paralegal-v2.html#/payouts", keywords: "earnings payments balance" },
  { label: "History", href: "/paralegal-v2.html#/work?section=history", keywords: "past matters archive history payouts receipts" },
  { label: "Profile Settings", href: "/paralegal-v2.html#/settings?tab=profile", recentAliases: ["/paralegal-v2.html#/settings"], keywords: "resume bio photo skills" },
  { label: "Security settings", href: "/paralegal-v2.html#/settings?tab=security", keywords: "password sessions two factor mfa stripe" },
  { label: "Change password", href: "/paralegal-v2.html#/settings?tab=security&section=password", keywords: "security account sign in credentials" },
  { label: "Preferences", href: "/paralegal-v2.html#/settings?tab=preferences", keywords: "notifications appearance accessibility theme" },
  { label: "Help", href: "/paralegal-v2.html#/help", keywords: "support report issue guidance" },
]);

export function createSearchController(options) {
  return createWorkspaceSearch({
    ...options, commands: COMMANDS, types: ["matter", "file"], prefix: "v2-search", inline: true, dashboardPresentation: true, showInitialCommands: false, routeAttribute: "data-v2-route",
    verifySession: request => verifyParalegalSession(options.api, request),
    destinationFor: row => {
      try {
        if(row.type==='file'){const expected=`/paralegal-v2.html#/matter/${row.matterId}?tab=files&fileId=${row.id}`;return row.nextAction.href===expected?{href:expected,internal:true}:null;}
        const url = new URL(row.nextAction.href, location.origin);
        if (url.origin !== location.origin || !["/case-detail.html", "/browse-jobs.html"].includes(url.pathname) || url.searchParams.get("caseId") !== row.id || url.username || url.password) return null;
        return adaptLegacyDestination(row.nextAction.href, { caseId: row.id });
      } catch { return null; }
    },
  });
}
