import { classifySession } from './session-boundary.mjs';
import { createClosureApi as createAccountClosureApi } from '../utils/account-closure-api.mjs';
export { ClosureError, closureReview, closureResult } from '../utils/account-closure-api.mjs';

export function createClosureApi(options = {}) {
  return createAccountClosureApi({ ...options, classifySession });
}
