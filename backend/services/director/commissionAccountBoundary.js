const account = require('../financialAccountBoundary');
const { fingerprint } = require('../matterDraftRevision');
async function begin(req, res) {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie'); res.vary('Authorization');
  const expectedOwnerId = req.query?.expectedOwnerId;
  const first = await account.read(req, req.user.role, expectedOwnerId);
  return async () => {
    const current = await account.read(req, req.user.role, expectedOwnerId);
    if (fingerprint(first) !== fingerprint(current)) throw Object.assign(new Error('The signed-in account changed. Refresh to continue.'), { statusCode: 403 });
  };
}
module.exports = { begin };
