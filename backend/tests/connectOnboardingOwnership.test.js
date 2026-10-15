const User = require('../models/User');
jest.mock('../utils/stripe', () => ({
  accountLinks: { create: jest.fn(async () => ({ url: 'https://connect.stripe.com/setup/synthetic-only' })) },
}));
const stripe = require('../utils/stripe');
const router = require('../routes/payments');
const handler = router.stack.find(layer => layer.route?.path === '/connect/onboard-link').route.stack.at(-1).handle;
const ownerId = '111111111111111111111111';
let lookup;
beforeEach(() => {
  jest.clearAllMocks();
  lookup = jest.spyOn(User, 'findById');
});
afterEach(() => lookup.mockRestore());
async function invoke(savedAccount, body = {}, { missingUser = false } = {}) {
  lookup.mockReturnValue({ select: jest.fn(async () => missingUser ? null : { stripeAccountId: savedAccount }) });
  const res = { statusCode: 200, status: jest.fn(function(value) { this.statusCode = value; return this; }), json: jest.fn(function(value) { this.body = value; return this; }) };
  await handler({ user: { id: ownerId }, body }, res, error => { throw error; });
  expect(lookup).toHaveBeenCalledWith(ownerId);
  return res;
}
test('an accountless member cannot obtain an onboarding link for another account', async () => {
  const res = await invoke(undefined, { accountId: 'acct_other' });
  expect(res.statusCode).toBe(400);
  expect(stripe.accountLinks.create).not.toHaveBeenCalled();
});
test('an accountless member must first create their own account', async () => {
  expect((await invoke(undefined)).statusCode).toBe(400);
  expect(stripe.accountLinks.create).not.toHaveBeenCalled();
});
test('a member cannot replace their saved account with another request account', async () => {
  expect((await invoke('acct_owner', { accountId: 'acct_other' })).statusCode).toBe(403);
  expect(stripe.accountLinks.create).not.toHaveBeenCalled();
});
test.each([{}, { accountId: 'acct_owner' }])('the saved owner account remains usable: %j', async body => {
  expect((await invoke('acct_owner', body)).statusCode).toBe(200);
  expect(stripe.accountLinks.create).toHaveBeenCalledTimes(1);
  expect(stripe.accountLinks.create.mock.calls[0][0].account).toBe('acct_owner');
});
test('a removed member cannot obtain an onboarding link', async () => {
  expect((await invoke('acct_owner', {}, { missingUser: true })).statusCode).toBe(404);
  expect(stripe.accountLinks.create).not.toHaveBeenCalled();
});
