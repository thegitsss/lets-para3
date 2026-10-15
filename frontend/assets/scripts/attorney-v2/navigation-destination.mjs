import { currentWorkspaceDestination } from "../utils/workspace-destinations.mjs";
import { notificationDestination } from "./routes.mjs";

// Assistant commands include creation workflows as well as notifications.
// Reuse the canonical current-account adapter so those workflows retain their
// exact draft, posted-Matter and return context inside this workspace.
export function resolveAttorneyNavigation(href, origin = "https://lpc.invalid") {
  const current = currentWorkspaceDestination("attorney", href, { origin });
  return current ? { href: current, internal: true }
    : notificationDestination({ action: { href } }, origin);
}
