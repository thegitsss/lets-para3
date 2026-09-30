import { createBlockedApi as createAccountBlockedApi } from '../utils/account-blocked-api.mjs';
import { classifySecuritySession } from './security-api.mjs';
export { BlockedError, blockedPage, blockedStatus } from '../utils/account-blocked-api.mjs';

export function createBlockedApi(options = {}) {
  return createAccountBlockedApi({ ...options, classifySession: classifySecuritySession });
}
