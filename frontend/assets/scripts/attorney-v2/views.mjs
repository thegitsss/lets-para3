import { createMatterWorkspace } from "./workspace.mjs";
import { createPaymentSetup } from "./payment-setup.mjs";
import { createPaymentsPage } from "./payments-page.mjs";
import { createApplicationsPage } from "./matter-applications.mjs";
import { createExportPage } from "./matter-exports.mjs";
import { createArchivePage } from "./matter-archive.mjs";
import { createDownloadsPage } from "./matter-downloads.mjs";
import { createReceiptPage } from "./matter-receipts.mjs";
import { legacyDestination } from "./routes.mjs";
import { node } from "./dom.mjs";
import { createConversations } from "./conversations.mjs";
import { createHome } from "./home.mjs";
import { createInvitationsPage } from "./matter-invitations.mjs";
import { createMatterManagement } from "./matter-management.mjs";
import { createMatters } from "./matters.mjs";
import { createTasks } from "./tasks.mjs";
import { createDirectory, createCandidate } from "./discovery.mjs";
import { createPostingEditor } from "./posting-editor.mjs";
import { createDraftEditor } from "./draft-editor.mjs";
import { createAccountView } from "./account-view.mjs";
import { createOwnProfileView } from "./own-profile-view.mjs";
import { createReportStatusPage } from "../utils/report-status.mjs";
import { createAttorneyHelpView } from "./help-view.mjs";
export { node } from "./dom.mjs";

export function createView(route, identity, context) {
  if (route.name === "conversations") return createConversations(route, identity, context);
  if (route.name === "help" && route.query.has("incident")) return createReportStatusPage(route.query.get("incident"), { ...context, identity, routeAttribute: "data-av2-route" });
  if (route.name === "help") return createAttorneyHelpView(route, identity, context);
  if (route.name === "settings") return createAccountView(route, identity, context);
  if (route.name === "profile") return createOwnProfileView(route, identity, context);
  if (["matter-management", "matter-invitations", "matter-archive"].includes(route.name)) return createMatterWorkspace({...route, tab: {"matter-management":"manage", "matter-invitations":"invitations", "matter-archive":"archive"}[route.name]}, identity, context);
  if (route.caseId && route.tab) return createMatterWorkspace(route, identity, context);
  if (route.name === "payment-setup") return createPaymentSetup(route, identity, context);
  if (route.name === "payments") return createPaymentsPage(route, identity, context);
  if (route.name === "matter-applications") return createApplicationsPage(route, identity, context);
  if (route.name === "matter-export") return createExportPage(route, identity, context);
  if (route.name === "matter-receipt") return createReceiptPage(route, identity, context);
  if (route.name === "matter-downloads") return createDownloadsPage(route, identity, context);
  if (route.name === "matter-archive") return createArchivePage(route, identity, context);
  if (route.name === "home") return createHome(identity, context);
  if (route.name === "matter-invitations") return createInvitationsPage(route, identity, context);
  if (route.name === "matter-management") return createMatterManagement(route, identity, context);
  if (route.name === "matters") return createMatters(route, identity, context);
  if (route.name === "tasks") return createTasks(route, identity, context);
  if (route.name === "paralegals") return createDirectory(route, { ...context, ownerId: identity.id });
  if (route.name === "candidate") return createCandidate(route, { ...context, ownerId: identity.id });
  if (route.name === "create" && route.query.has("caseId")) return createPostingEditor(route, identity, context);
  if (route.name === "create" && !route.query.has("caseId")) return createDraftEditor(route, identity, context);
  const title = route.name === "home" ? `Welcome${identity.firstName ? `, ${identity.firstName}` : ""}` : route.title;
  const section = node("section", { className: "av2-view", "aria-labelledby": "av2-page-title" });
  const header = node("div", { className: "av2-view-header" }, [
    node("h1", { id: "av2-page-title", text: title }),
    node("p", { className: "av2-lead", text: route.found ? route.description : "This page is unavailable. Choose a section from the navigation to continue." }),
  ]);
  if (route.found) header.append(node("a", { className: "av2-button", href: legacyDestination(route), text: route.name === "home" ? "Open current workspace" : `Open ${route.title.toLowerCase()}` }));
  else header.append(node("a", { className: "av2-button", href: "#/home", "data-av2-route": "home", text: "Go to Home" }));
  section.append(header);
  if (route.found) section.append(node("p", { className: "av2-preview-note", text: "Navigation preview. Your work opens in the current workspace while the new pages are being prepared." }));
  return section;
}

export function createRouteError(retry) {
  const button = node("button", { type: "button", className: "av2-button", text: "Try again" });
  button.addEventListener("click", retry);
  return node("section", { className: "av2-view", role: "alert" }, [node("h1", { text: "This page couldn’t load" }), node("p", { className: "av2-lead", text: "Try again or choose another section." }), button]);
}
