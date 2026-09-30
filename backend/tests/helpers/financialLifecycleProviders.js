// Synthetic external-provider boundary for the actual writer/browser lifecycle.
// No app response, financial predicate or persisted record is replaced here.
module.exports = function install() {
  const calls = [];
  const record = (impl = async () => { throw Error('Unsupported synthetic provider call'); }) => (...args) => impl(...args);
const mockStripeState = {
  defaultPaymentMethodId: null,
  captureAvailable: true,
  paymentIntent: null,
  refund: null,
  refundStatus: "succeeded",
  cardDispute: null,
};
function mockFundingCharge() {
  return {
    id: "ch_phase2_funding", payment_intent: "pi_phase2_funding", currency: "usd",
    paid: true, captured: true, disputed: Boolean(mockStripeState.cardDispute), livemode: false, status: "succeeded",
    object: "charge", created: Date.parse("2026-09-01T15:00:00.000Z") / 1000,
    amount: 48_800, amount_captured: 48_800, amount_refunded: mockStripeState.refund?.status === "succeeded" ? mockStripeState.refund.amount : 0,
    refunded: mockStripeState.refund?.status === "succeeded" && mockStripeState.refund.amount === 48_800,
    balance_transaction: {
      id: "txn_phase2_funding", type: "charge", source: "ch_phase2_funding",
      amount: 48_800, fee: 1_400, net: 47_400, currency: "usd",
    },
  };
}
function mockTransfer(params, id = "tr_phase2_payout") {
  return { id, object: "transfer", ...params, livemode: false, reversed: false, amount_reversed: 0, created: Math.floor(Date.now() / 1000) };
}
function mockCardDispute(caseId, { created = Math.floor(Date.now() / 1000) } = {}) {
  const id = "dp_phase2_card";
  return { id, object: "dispute", status: "under_review", amount: 48_800, currency: "usd", livemode: false, charge: "ch_phase2_funding", payment_intent: "pi_phase2_funding", created, metadata: { caseId }, balance_transactions: [{ id: "txn_phase2_card_debit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute", source: id, amount: -48_800, fee: 1500, net: -50_300, currency: "usd", created }] };
}
function mockCardRecovery(created = Math.floor(Date.now() / 1000)) {
  mockStripeState.cardDispute.status = "won";
  mockStripeState.cardDispute.balance_transactions.push({ id: "txn_phase2_card_credit", object: "balance_transaction", type: "adjustment", reporting_category: "dispute_reversal", source: mockStripeState.cardDispute.id, amount: 48_800, fee: -1500, net: 50_300, currency: "usd", created });
}

const synthetic = {
  webhooks: { constructEvent: record((body, signature) => {
    if (!Buffer.isBuffer(body) || signature !== "synthetic-phase2-signature") throw Error("Invalid synthetic delivery");
    return JSON.parse(body.toString());
  }) },
  customers: {
    create: record(async () => ({ id: "cus_phase2_attorney", object: "customer", livemode: false })),
    retrieve: record(async () => ({
      id: "cus_phase2_attorney", object: "customer", livemode: false,
      invoice_settings: { default_payment_method: mockStripeState.defaultPaymentMethodId },
    })),
    update: record(async (_customerId, update) => {
      mockStripeState.defaultPaymentMethodId = update?.invoice_settings?.default_payment_method || null;
      return { id: "cus_phase2_attorney", object: "customer", livemode: false, invoice_settings: update.invoice_settings };
    }),
  },
  paymentMethods: {
    retrieve: record(async (id) => ({
      id, object: "payment_method", livemode: false,
      type: "card",
      customer: "cus_phase2_attorney",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    })),
    attach: record(async (id) => ({ id, object: "payment_method", livemode: false, type: "card", customer: "cus_phase2_attorney", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } })),
  },
  setupIntents: { create: record() },
  charges: { retrieve: record(async id => {
    if (id !== "ch_phase2_funding") throw Error("Unknown synthetic funding charge");
    if (!mockStripeState.captureAvailable) throw Error("Synthetic charge lookup unavailable");
    return mockFundingCharge();
  }) },
  disputes: {
    retrieve: record(async id => { if (id !== mockStripeState.cardDispute?.id) throw Error("Unknown synthetic card dispute"); return structuredClone(mockStripeState.cardDispute); }),
    list: record(async params => {
      if (params.charge !== "ch_phase2_funding" || params.limit !== 100 || params.starting_after) throw Error("Unknown synthetic card-dispute page");
      return { data: mockStripeState.cardDispute ? [structuredClone(mockStripeState.cardDispute)] : [], has_more: false };
    }),
  },
  balanceTransactions: { retrieve: record(async id => { const value = mockStripeState.cardDispute?.balance_transactions.find(row => row.id === id); if (!value) throw Error("Unknown synthetic card-dispute balance transaction"); return structuredClone(value); }) },
  accounts: {
    create: record(),
    retrieve: record(async () => ({ details_submitted: true, charges_enabled: true, payouts_enabled: true })),
  },
  paymentIntents: {
    create: record(async (params) => (mockStripeState.paymentIntent = {
      id: "pi_phase2_funding",
      object: "payment_intent",
      status: "succeeded",
      amount: params.amount,
      amount_received: params.amount,
      currency: params.currency,
      customer: params.customer,
      transfer_group: params.transfer_group,
      metadata: params.metadata,
      latest_charge: { id: "ch_phase2_funding", payment_intent: "pi_phase2_funding", currency: "usd", paid: true, captured: true, disputed: false, amount_captured: 48_800, amount_refunded: 0 },
      livemode: false,
    })),
    retrieve: record(async id => {
      if (!mockStripeState.paymentIntent || id !== mockStripeState.paymentIntent.id) throw Error("Unknown synthetic PaymentIntent");
      return { ...mockStripeState.paymentIntent, latest_charge: mockStripeState.captureAvailable ? mockFundingCharge() : "ch_phase2_funding" };
    }),
    cancel: record(),
  },
  refunds: {
    create: record(async params => {
      if (params.payment_intent !== "pi_phase2_funding") throw Error("Unknown synthetic refund payment");
      return (mockStripeState.refund = { id: "re_phase2_settlement", object: "refund", amount: params.amount, currency: "usd", payment_intent: params.payment_intent, charge: "ch_phase2_funding", metadata: params.metadata, status: mockStripeState.refundStatus, livemode: false, created: Math.floor(Date.now() / 1000), balance_transaction: mockStripeState.refundStatus === "succeeded" ? "txn_phase2_refund" : null });
    }),
    retrieve: record(async id => { if (id !== mockStripeState.refund?.id) throw Error("Unknown synthetic refund"); return mockStripeState.refund; }),
    list: record(async () => ({ data: mockStripeState.refund ? [mockStripeState.refund] : [], has_more: false })),
  },
  transfers: {
    create: record(async (params) => mockTransfer(params)),
  },
};
  const stripe = require('../../utils/stripe');
  const forbidden = () => { calls.push({ method: 'forbidden_network' }); throw Error('External Stripe network is forbidden in this fixture'); };
  // The SDK transport is disabled even for resources outside this scenario.
  stripe._requestSender._request = forbidden;
  synthetic.accounts.retrieve = async id => ({ id, object: 'account', livemode: false, details_submitted: true, charges_enabled: true, payouts_enabled: true, default_currency: 'usd', requirements: { currently_due: [], past_due: [], disabled_reason: null }, capabilities: { transfers: 'active', card_payments: 'active' } });
  synthetic.transfers.create = async params => mockTransfer(params, `tr_browser_${calls.filter(row => row.method === 'transfers.create').length}`);
  for (const [resource, methods] of Object.entries(synthetic)) for (const [method, impl] of Object.entries(methods)) {
    stripe[resource][method] = async (...args) => {
      calls.push({ method: `${resource}.${method}`, args: structuredClone(args) });
      return impl(...args);
    };
  }
  // Signature verification is synchronous at the webhook boundary.
  stripe.webhooks.constructEvent = synthetic.webhooks.constructEvent;
  return { stripe, state: mockStripeState, calls, cardDispute: mockCardDispute, cardRecovery: mockCardRecovery,
    reset() { calls.length = 0; Object.assign(mockStripeState, { defaultPaymentMethodId: null, captureAvailable: true, paymentIntent: null, refund: null, refundStatus: 'succeeded', cardDispute: null }); },
  };
};
