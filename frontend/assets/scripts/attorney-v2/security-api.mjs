import { classifySession } from "./session-boundary.mjs";
import { createSecurityApi as createAccountSecurityApi } from "../utils/account-security-api.mjs";
export { SecurityError, securityState } from "../utils/account-security-api.mjs";

export function createSecurityApi(options = {}) {
  return createAccountSecurityApi({ ...options, classifySession });
}
