// Keep leases in memory: separate tabs must never inherit each other's presence.
// Revisions order the intent before any account check or network await begins.
export function createWorkspacePresenceLease() {
  const presenceId = globalThis.crypto.randomUUID();
  let revision = 0;
  return Object.freeze({ next: () => ({ presenceId, revision: ++revision }) });
}
