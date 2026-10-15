const changed = () => new Error('The signed-in account changed. Refresh to verify this page.');
const unavailable = () => new Error('The import result could not be verified. Refresh and review saved records before syncing again.');

// A manual sync is one reviewed owner intent across both POSTs and the readback.
export function createDirectorManualImport({ getAccount, isCurrent, request, reload, setStatus, onDiscard = () => {} }) {
  let generation = 0;
  function verify(intent, payload) {
    if (intent.generation !== generation || !isCurrent(intent.account)) throw changed();
    intent.account.verify(payload);
  }
  async function importMailbox(intent, path) {
    verify(intent);
    let response;
    try { response = await request(intent.account.url(path)); }
    catch { throw unavailable(); }
    const payload = await response.json().catch(() => ({}));
    verify(intent);
    if (!response.ok) throw Object.assign(new Error(payload.code === 'DIRECTOR_IMPORT_SAVED_REVIEW' ? 'The import was saved. Sign in and review your records before syncing again.' : response.status >= 500 ? 'Import unavailable. Refresh and review saved records before syncing again.' : payload.error || payload.message || 'Import unavailable. Refresh to verify your account.'), { authorityDenied: response.status === 403 });
    intent.account.verify(payload);
    if (payload.ok !== true || !Number.isSafeInteger(payload.imported) || payload.imported < 0 || !Number.isSafeInteger(payload.scanned) || payload.scanned < 0) throw unavailable();
    return payload;
  }
  async function run({ repliesOnly = false, silent = false, readback = true } = {}) {
    const intent = { generation: ++generation, account: getAccount(), sentAccepted: false, repliesAccepted: false };
    try {
      if (!intent.account) throw new Error('Director access could not be verified. Refresh to try again.');
      verify(intent);
      if (!silent) setStatus(repliesOnly ? 'Checking replies...' : 'Syncing Zoho...');
      let sent;
      if (!repliesOnly) {
        sent = await importMailbox(intent, '/api/director/import-today');
        intent.sentAccepted = true;
      }
      const replies = await importMailbox(intent, '/api/director/import-replies');
      intent.repliesAccepted = true;
      verify(intent);
      if (readback && await reload(intent.account) !== true) throw unavailable();
      verify(intent);
      if (!silent) setStatus(repliesOnly ? `Replies flagged: ${replies.imported}` : `Sync complete: ${sent.imported} sent message${sent.imported === 1 ? '' : 's'} imported.`, { tone: 'success', transient: !repliesOnly });
      return { ok: true, sent, replies };
    } catch (error) {
      if (intent.generation !== generation) return { ok: false, discarded: true };
      try { if (intent.account) verify(intent); }
      catch { onDiscard(intent.account); return { ok: false, discarded: true }; }
      const message = intent.sentAccepted ? intent.repliesAccepted ? 'Mailbox import saved. Current records could not be refreshed. Refresh to review them.' : 'Sent mail imported. Reply checking was not completed. Refresh and review before syncing again.' : intent.repliesAccepted ? 'Replies imported. Current records could not be refreshed. Refresh to review them.' : error.message || unavailable().message;
      if (error.authorityDenied) onDiscard(intent.account);
      setStatus(message, { tone: 'error' });
      return { ok: false };
    }
  }
  return { sync: () => run(), replies: ({ silent = false, reload = true } = {}) => run({ repliesOnly: true, silent, readback: reload }) };
}
