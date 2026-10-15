const identity = session => {
  const user = session?.user;
  return JSON.stringify([String(user?.id || user?._id || ''), String(user?.role || ''), String(user?.status || ''), Boolean(user?.disabled), Boolean(user?.deleted)]);
};
const denied = () => Object.assign(new Error('Director access could not be verified. Sign in again to continue.'), { status: 403 });
const changed = () => Object.assign(new Error('The signed-in account changed. Reload this page to continue.'), { status: 403 });

// Establish the first document from the current cookie, before creating its
// pinned financial reader. Later reads retain the server's expected-owner gate.
export function createDirectorPortalSession({ readCurrentUser, readSession, persistUser, createAccount, isDocumentActive, onConfirmedNoSession }) {
  let generation = 0, ownerId = '', account = null, pending = null;
  async function authorize() {
    if (pending) return pending;
    const requestGeneration = generation, before = readSession(), beforeIdentity = identity(before);
    const previousOwner = String(before?.user?.id || before?.user?._id || '');
    const operation = (async () => {
      if (!isDocumentActive()) throw changed();
      let user = await readCurrentUser();
      if (requestGeneration !== generation || !isDocumentActive() || identity(readSession()) !== beforeIdentity) throw changed();
      if (user === null) {
        // An older absent response can precede a new same-owner cookie while
        // leaving the public identity unchanged. Confirm the current cookie.
        user = await readCurrentUser();
        if (requestGeneration !== generation || !isDocumentActive() || identity(readSession()) !== beforeIdentity) throw changed();
        if (user === null) {
          onConfirmedNoSession?.();
          throw denied();
        }
      }
      const currentOwner = String(user?.id || user?._id || '');
      if (!/^[a-f0-9]{24}$/i.test(currentOwner) || user?.role !== 'director' || user?.status !== 'approved' || user?.disabled || user?.deleted) throw denied();
      if ((ownerId && currentOwner !== ownerId) || (previousOwner && currentOwner !== previousOwner)) throw changed();
      persistUser(user);
      const next = account || createAccount();
      next.verify();
      ownerId = currentOwner;
      if (!account) {
        const verify = payload => {
          const current = readSession()?.user;
          if (!isDocumentActive() || String(current?.id || current?._id || '') !== ownerId || current?.role !== 'director' || current?.status !== 'approved' || current?.disabled || current?.deleted) throw changed();
          next.verify(payload);
        };
        account = { ownerId, verify, url(path) { verify(); return next.url(path); } };
      }
      return account;
    })();
    pending = operation;
    try { return await operation; }
    finally { if (pending === operation) pending = null; }
  }
  return { authorize, invalidate() { generation += 1; pending = null; } };
}
