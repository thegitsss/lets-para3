const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const proof = value => typeof value === 'string' && value.length <= 2048 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value);

export class ClosureError extends Error {
  constructor(kind, status = 0) {
    super(kind === 'expired' ? 'This account check expired. Review account closure again.' : kind === 'conflict' ? 'Account closure changed. Review the current information before continuing.' : kind === 'uncertain' ? 'The account closure result could not be confirmed. Check the current account status.' : 'Account closure could not be checked. Try again.');
    this.name = 'ClosureError';this.kind = kind;this.status = status;
  }
}

export function closureReview(value, ownerId) {
  const codes = new Set(['active_matters', 'open_disputes', 'unresolved_financials', 'pending_payouts', 'already_deactivated', 'not_found']);
  if (!plain(value) || value.ownerId !== ownerId || typeof value.canDeactivate !== 'boolean' || !Array.isArray(value.blockers) || value.blockers.length > 20 || !hash(value.closureRevision) || !proof(value.resultProof) || typeof value.proofExpiresAt !== 'string' || !Number.isFinite(new Date(value.proofExpiresAt).getTime())) throw new ClosureError('invalid_response');
  const seen = new Set();
  const blockers = value.blockers.map(item => {
    if (!plain(item) || !codes.has(item.code) || seen.has(item.code) || typeof item.message !== 'string' || !item.message || item.message.length > 1000 || !Number.isSafeInteger(item.count) || item.count < 0) throw new ClosureError('invalid_response');
    seen.add(item.code);return {code:item.code,message:item.message,count:item.count};
  });
  if (value.canDeactivate !== (blockers.length === 0)) throw new ClosureError('invalid_response');
  return {ownerId,canDeactivate:value.canDeactivate,blockers,closureRevision:value.closureRevision,resultProof:value.resultProof,proofExpiresAt:value.proofExpiresAt};
}

export function closureResult(value) {
  if (!plain(value) || !['active', 'deactivated', 'unavailable'].includes(value.state)) throw new ClosureError('invalid_response');
  return {state:value.state};
}

export function createClosureApi({fetchImpl = globalThis.fetch.bind(globalThis), onAuthenticationLost, classifySession = () => ({state:'unauthenticated'})} = {}) {
  let generation = 0;const pending = new Set();
  async function request(path, {signal, method = 'GET', headers = {}, body} = {}) {
    const ticket = generation, controller = new AbortController(), abort = () => controller.abort();let timedOut = false;
    const timer = setTimeout(() => {timedOut = true;abort();}, 30000);
    pending.add(controller);signal?.addEventListener('abort', abort, {once:true});if (signal?.aborted) abort();
    try {
      const response = await fetchImpl(path, {method, body, headers:{Accept:'application/json',...headers}, credentials:'include', cache:'no-store', redirect:'error', signal:controller.signal});
      const payload = await response.json().catch(() => null);
      if (signal?.aborted || ticket !== generation || controller.signal.aborted && !timedOut) throw new DOMException('Canceled', 'AbortError');
      if (timedOut) throw new ClosureError(method === 'DELETE' ? 'uncertain' : 'network');
      if (!response.ok) {
        const lost = response.status === 401 || response.status === 403 && payload?.code === 'ACCOUNT_CHANGED';
        if (lost) onAuthenticationLost?.();
        throw new ClosureError(lost ? 'authentication' : response.status === 410 ? 'expired' : payload?.code === 'ACCOUNT_CLOSURE_PROOF_INVALID' ? 'invalid_proof' : response.status === 409 ? 'conflict' : method === 'DELETE' && response.status >= 500 ? 'uncertain' : 'request', response.status);
      }
      if (!plain(payload)) throw new ClosureError(method === 'DELETE' ? 'uncertain' : 'invalid_response');
      return payload;
    } catch (error) {
      if (signal?.aborted || ticket !== generation) throw new DOMException('Canceled', 'AbortError');
      if (error instanceof ClosureError) throw error;
      throw new ClosureError(method === 'DELETE' ? 'uncertain' : 'network');
    } finally {clearTimeout(timer);pending.delete(controller);signal?.removeEventListener('abort', abort);}
  }
  async function verify(options) {
    if (!id(options?.ownerId)) throw new ClosureError('authentication');
    const current = classifySession(await request('/api/auth/me', options));
    if (current.state !== 'ready' || current.identity.id !== options.ownerId) {onAuthenticationLost?.();throw new ClosureError('authentication');}
  }
  return Object.freeze({
    async readReview(options) {
      await verify(options);
      const value = await request(`/api/account/deactivate-status?${new URLSearchParams({expectedOwnerId:options.ownerId})}`, options);
      await verify(options);return closureReview(value, options.ownerId);
    },
    async deactivate(review, options) {
      if (!review?.canDeactivate || review.ownerId !== options?.ownerId || !hash(review.closureRevision) || !proof(review.resultProof)) throw new ClosureError('invalid_request');
      let csrf;
      try {
        await verify(options);
        csrf = await request('/api/csrf', options);
        if (typeof csrf.csrfToken !== 'string' || !csrf.csrfToken) throw new ClosureError('invalid_response');
        // The view retains its recovery capability only after read-only
        // preflight succeeds, immediately before the consequential request.
        options.beforeDispatch?.();
      } catch (error) {error.dispatched = false;throw error;}
      try {
        const value = await request('/api/account/deactivate', {...options, method:'DELETE', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf.csrfToken}, body:JSON.stringify({expectedOwnerId:options.ownerId,expectedClosureRevision:review.closureRevision,resultProof:review.resultProof})});
        if (value.ok !== true || value.deactivated !== true) throw new ClosureError('uncertain');
      } catch (error) {error.dispatched = true;throw error;}
      // The acknowledged operation ends this session. A later account-status
      // check uses the bounded proof, never an active-authentication inference.
      return {ok:true,deactivated:true};
    },
    async readResult(resultProof, options = {}) {
      if (!proof(resultProof)) throw new ClosureError('invalid_request');
      return closureResult(await request('/api/account/deactivate-result', {...options, headers:{'X-LPC-Closure-Proof':resultProof}}));
    },
    clear() {generation++;pending.forEach(controller => controller.abort());pending.clear();},
  });
}
