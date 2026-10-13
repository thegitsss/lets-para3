const DRAFT = "lpc:v2:help-draft:", ACCESS = "incident-access:";
const validOwner = value => typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);

function storedHelpEntries(visit) {
  try {
    const storage = globalThis.sessionStorage;
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(DRAFT) && !key.startsWith(ACCESS)) continue;
      try { visit(storage, key); } catch { /* An unavailable entry does not prevent other cleanup. */ }
    }
  } catch { /* Storage can be unavailable; in-memory Help remains account scoped. */ }
}

export function scopeHelpStorageToOwner(ownerId) {
  // Partial preference/photo snapshots and transient session failures do not
  // establish another owner and must not erase a recoverable report.
  if (!validOwner(ownerId)) return;
  storedHelpEntries((storage, key) => {
    let value;
    try { value = JSON.parse(storage.getItem(key)); } catch {}
    const belongs = value?.reporterId === ownerId && (key.startsWith(ACCESS) || key === `${DRAFT}${ownerId}`);
    // Old unstamped Help tokens have no provable account association. Their
    // authenticated reporter can still read the report through the API.
    if (!belongs) storage.removeItem(key);
  });
}

export function clearHelpStorage() {
  storedHelpEntries((storage, key) => storage.removeItem(key));
}
