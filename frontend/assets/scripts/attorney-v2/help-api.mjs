import { createHelpApi as createSharedHelpApi } from "../utils/help-api.mjs";
import { classifySession } from "./session-boundary.mjs";
import { readMatter } from "./workspace-model.mjs";
export { HelpError } from "../utils/help-api.mjs";

export function createHelpApi(options) {
  return createSharedHelpApi({ ...options,
    verifySession: async request => classifySession(await options.api.get("/api/auth/me", request)),
    readMatterContext: async (caseId, request) => readMatter(await options.api.readWorkspaceMatter(caseId, request), caseId),
  });
}
