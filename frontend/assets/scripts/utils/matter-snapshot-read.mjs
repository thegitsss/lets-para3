const SNAPSHOT_CONFLICTS = new Set(['WORKSPACE_CHANGED', 'APPLICATION_REVIEW_CHANGED', 'MATTER_FINANCIAL_CHANGED']);

// Recheck a raced read once. Each read retains its original account boundary;
// a repeated conflict or lost access returns to the caller's recovery state.
export async function readStableMatterSnapshot(read, { signal, isCurrent = () => true } = {}) {
  try { return await read(); }
  catch (error) {
    const code = error.code || error.payload?.code;
    if (signal?.aborted || !isCurrent() || error.status !== 409 || !SNAPSHOT_CONFLICTS.has(code)) throw error;
    return read();
  }
}
