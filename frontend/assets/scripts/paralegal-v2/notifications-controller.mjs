import { createNotificationCenter } from "../utils/notification-center.mjs";
import { adaptLegacyDestination, navigateToDestination } from "./deep-links.mjs";

export function createNotificationsController(options) {
  return createNotificationCenter({
    ...options,
    destinationFor: item => adaptLegacyDestination(item?.action?.href, { caseId: item?.context?.caseId }),
    navigate: navigateToDestination,
  });
}
