import { projectSessionIdentity } from "./session-boundary.mjs";
import { createSecurityApi as createAccountSecurityApi } from "../utils/account-security-api.mjs";
export { SecurityError, securityState } from "../utils/account-security-api.mjs";

export function classifySecuritySession(payload) {
  const identity = projectSessionIdentity(payload?.user);
  if (!identity) return { state: "unauthenticated", identity: null };
  if (identity.disabled || identity.deleted) return { state: "unavailable", identity };
  if (identity.role !== "paralegal") return { state: "wrong_role", identity };
  if (identity.status !== "approved") return { state: "unapproved", identity };
  return { state: "ready", identity };
}

export function createSecurityApi(options = {}) {
  return createAccountSecurityApi({ ...options, classifySession: classifySecuritySession });
}
