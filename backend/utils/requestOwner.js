// Bound callers identify the account that owns their displayed workspace.
// Existing clients without this header retain their established route contract.
module.exports = function requestOwner(req, res, next) {
  const expected = req.get('X-LPC-Owner-Id');
  if (expected === undefined) return next();
  if (!/^[a-f0-9]{24}$/i.test(expected)) return res.status(400).json({ code: 'INVALID_OWNER', error: 'The workspace account could not be verified. Reload the workspace.' });
  if (expected.toLowerCase() !== String(req.user?.id || '').toLowerCase()) return res.status(403).json({ code: 'ACCOUNT_CHANGED', error: 'The signed-in account changed. Reload your workspace.' });
  return next();
};
