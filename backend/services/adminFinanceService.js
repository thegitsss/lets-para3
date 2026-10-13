const mongoose = require('mongoose');
const Case = require('../models/Case');
const User = require('../models/User');
const PaymentOperation = require('../models/PaymentOperation');
const Payout = require('../models/Payout');
const PlatformIncome = require('../models/PlatformIncome');
const DirectorOutreachRecord = require('../models/DirectorOutreachRecord');
const financial = require('./adminFinancialReport');
const { fingerprint } = require('./matterDraftRevision');
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function financeQuery(input = {}) {
  const kind = ['operations', 'payouts', 'income', 'pending', 'commissions'].includes(input.kind) ? input.kind : 'operations';
  const Model = {
    operations: PaymentOperation,
    payouts: Payout,
    income: PlatformIncome,
    pending: Case,
    commissions: DirectorOutreachRecord
  }[kind];
  const query = {};
  if (kind === 'pending') Object.assign(query, {
    status: {
      $in: ['completed', 'closed']
    },
    paymentReleased: {
      $ne: true
    },
    payoutFinalizedAt: null,
    escrowStatus: 'funded',
    $and: [{
      $or: [{
        paralegal: {
          $ne: null
        }
      }, {
        paralegalId: {
          $ne: null
        }
      }]
    }, {
      $or: [{
        lockedTotalAmount: {
          $gt: 0
        }
      }, {
        totalAmount: {
          $gt: 0
        }
      }]
    }]
  });
  if (input.status && input.status !== 'all' && ['operations', 'payouts'].includes(kind)) query.status = input.status === 'exceptions' ? {
    $in: ['failed', 'needs_reconciliation']
  } : String(input.status);
  if (input.caseId && mongoose.isValidObjectId(input.caseId)) query[kind === 'pending' ? '_id' : 'caseId'] = new mongoose.Types.ObjectId(input.caseId);
  if (input.from || input.to) {
    query.createdAt = {};
    for (const [key, value] of [['$gte', input.from], ['$lt', input.to]]) {
      if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw Object.assign(new Error('Use a valid date range.'), {
        statusCode: 400
      });
      const date = new Date(value + 'T00:00:00.000Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw Object.assign(new Error('Use a valid date range.'), {
        statusCode: 400
      });
      if (key === '$lt') date.setUTCDate(date.getUTCDate() + 1);
      query.createdAt[key] = date;
    }
    if (query.createdAt.$gte && query.createdAt.$lt && query.createdAt.$gte >= query.createdAt.$lt) throw Object.assign(new Error('The end date must follow the start date.'), {
      statusCode: 400
    });
  }
  const q = String(input.q || '').trim().slice(0, 200);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    const people = await User.find({
      $or: [{
        firstName: rx
      }, {
        lastName: rx
      }, {
        email: rx
      }]
    }).select('_id').lean();
    const ids = people.map(p => p._id);
    const cases = await Case.find({
      $or: [{
        title: rx
      }, ...['attorney', 'attorneyId', 'paralegal', 'paralegalId'].map(key => ({
        [key]: {
          $in: ids
        }
      }))]
    }).select('_id').lean();
    const ors = kind === 'commissions' ? [{
      directorEmail: rx
    }, {
      attorneyEmail: rx
    }, {
      attorneyName: rx
    }] : kind === 'pending' ? [{
      _id: {
        $in: cases.map(c => c._id)
      }
    }, {
      title: rx
    }] : [{
      caseId: {
        $in: cases.map(c => c._id)
      }
    }, {
      operationKey: rx
    }, {
      transferId: rx
    }, {
      stripeObjectId: rx
    }, {
      stripePaymentIntentId: rx
    }, {
      stripeRefundId: rx
    }, {
      stripeTransferId: rx
    }, {
      stripeDisputeId: rx
    }];
    if (mongoose.isValidObjectId(q)) ors.push({
      _id: q
    }, ...(kind === 'pending' ? [] : [{
      caseId: q
    }]));
    query.$and = [...(query.$and || []), {
      $or: ors
    }];
  }
  return {
    Model,
    query,
    kind
  };
}
const selectedFields = {
  operations: 'caseId kind operationKey status amount currency stripeMode stripeObjectId stripePaymentIntentId stripeRefundId stripeTransferId stripeDisputeId evidenceStatus administrativeStatus processorStatus lastError createdAt updatedAt',
  payouts: 'caseId paralegalId operationKey amountPaid status transferId stripeMode failureReason createdAt',
  income: 'caseId operationKey feeAmount stripeMode createdAt',
  pending: 'title currency status paymentStatus payoutStatus payoutFailureReason fundingIntegrityStatus completionClaimStatus remainingAmount lockedTotalAmount totalAmount feeParalegalPct paralegal paralegalId createdAt deadlineDate',
  commissions: 'directorUserId directorEmail attorneyEmail attorneyName commissionEarnedCents commissionPayoutStatus createdAt updatedAt'
};
const { id, money, date, currency, fail } = financial;
async function records(input) {
  const { Model, query, kind } = await financeQuery(input);
  const projection = Object.fromEntries(selectedFields[kind].split(' ').map(field => [field, 1]));
  const rows = await Model.collection.find(query, { projection }).sort({ createdAt: -1, _id: -1 }).limit(10001).toArray();
  if (rows.length > 10000) fail(413, 'TOO_LARGE');
  return { rows, kind };
}
function normalizeRecord(doc, kind, report) {
  const caseId = kind === 'pending' ? id(doc._id) : id(doc.caseId);
  const matter = report.source.caseDocs.find(row => id(row._id) === caseId);
  let projected;
  if (kind === 'payouts') projected = report.value.allPayouts.find(row => row.id === id(doc._id));
  if (kind === 'income') projected = report.value.allIncome.find(row => row.id === id(doc._id));
  if (kind === 'pending') {
    const held = report.value.matters.find(row => row.caseId === caseId);
    projected = { state: held?.status === 'active' ? 'recorded' : 'needs_review', amount: held?.status === 'active' ? held.amountHeld : null, currency: held?.currency, stripeMode: held?.stripeMode, recordedAt: held?.fundedAt, basis: 'remaining_principal' };
  }
  if (kind === 'operations') {
    if (doc.kind === 'funding') projected = report.value.allFunding.find(row => row.id === id(doc._id));
    else if (['case_payout', 'partial_payout', 'dispute_settlement'].includes(doc.kind)) {
      const matches = report.value.allPayouts.filter(row => doc.operationKey && row.operationKey === doc.operationKey);
      if (matches.length === 1) projected = matches[0];
    } else if (doc.kind === 'refund' || doc.kind === 'chargeback') {
      const key = doc.kind === 'refund' ? doc.stripeRefundId || (/^re_/.test(doc.stripeObjectId || '') ? doc.stripeObjectId : id(doc._id)) : id(doc._id);
      projected = report.value.historyRows.find(row => row.id === fingerprint([caseId, [doc.kind, key]]));
    }
  }
  const requestedAmount = kind === 'payouts' ? doc.amountPaid : kind === 'income' ? doc.feeAmount : kind === 'commissions' ? doc.commissionEarnedCents : kind === 'pending' ? doc.remainingAmount ?? doc.lockedTotalAmount ?? doc.totalAmount : doc.amount;
  const code = projected?.currency || currency(doc.currency) || currency(matter?.currency);
  const stripeMode = projected?.stripeMode || (['test', 'live'].includes(doc.stripeMode) ? doc.stripeMode : 'unknown');
  const confirmed = projected?.state === 'recorded' && money(projected.amount) && code && ['test', 'live'].includes(stripeMode);
  return {
    id: id(doc._id), kind, caseId, title: matter?.title || doc.title || doc.attorneyName || '', currency: code,
    amount: confirmed ? projected.amount : null, requestedAmount: money(requestedAmount) ? requestedAmount : null,
    state: confirmed ? 'recorded' : projected?.state && projected.state !== 'recorded' ? projected.state : 'needs_review',
    status: kind === 'commissions' ? doc.commissionPayoutStatus : doc.status || 'unknown',
    createdAt: date(doc.createdAt), recordedAt: projected?.recordedAt || null,
    basis: projected?.basis || (kind === 'commissions' ? 'commission_estimate' : kind === 'income' ? 'income_to_verify' : 'operation_request'),
    details: doc.lastError || doc.failureReason || doc.payoutFailureReason || '', operationKind: doc.kind || '', stripeMode,
    reference: doc.transferId || doc.stripeTransferId || doc.stripeRefundId || doc.stripeDisputeId || doc.stripePaymentIntentId || doc.stripeObjectId || '',
    paymentStatus: doc.paymentStatus || '', evidenceStatus: doc.evidenceStatus || doc.fundingIntegrityStatus || '', directorEmail: doc.directorEmail || '', attorneyEmail: doc.attorneyEmail || ''
  };
}
function commissionRows(doc, source) {
  const record = require('./director/commissionEvidence').attach(doc, source), payment = record.commissionPayments;
  if (record.commissionState === 'none' && payment.state === 'none') return [];
  const groups = payment.groups.length ? payment.groups : [{ currency: null, stripeMode: 'unknown', outstandingCents: null, paidCents: null, earnedCents: null, state: 'needs_review' }];
  return groups.map(group => ({ id: `${id(doc._id)}:${group.currency || 'unknown'}:${group.stripeMode}`, recordId: id(doc._id), kind: 'commissions', caseId: '', title: doc.attorneyName || doc.attorneyEmail || 'Director referral', currency: group.currency,
    amount: group.outstandingCents, requestedAmount: null, earnedAmount: group.earnedCents, recordedPaidAmount: group.paidCents,
    state: group.state, status: payment.state, createdAt: date(doc.createdAt), recordedAt: null, basis: 'outstanding_commission',
    details: payment.legacyState === 'needs_review' ? 'Historical payment to verify' : payment.corrupt ? 'Payment history to verify' : '', operationKind: '', stripeMode: group.stripeMode, reference: '', directorEmail: doc.directorEmail || '', attorneyEmail: doc.attorneyEmail || '' }));
}
async function beginFinance(input = {}, req, { all = false } = {}) {
  const page = input.page === undefined ? 1 : Number(input.page), limit = input.limit === undefined ? 25 : Number(input.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || input.caseId && !mongoose.isValidObjectId(input.caseId)) fail(400, 'INVALID');
  const commissions = input.kind === 'commissions' ? await require('./director/directorPortalService').refreshDirectorRecords({ deferVerify: true }) : null;
  const report = await financial.begin(req), first = await records(input), { kind } = first;
  const revision = fingerprint([report.value.revision, kind, input.q || '', input.status || 'all', input.from || '', input.to || '', input.caseId || '', first, commissions?.financial.revision || null]);
  if (input.revision !== undefined && input.revision !== revision) fail(409, 'CHANGED');
  const rows = commissions ? first.rows.flatMap(doc => commissionRows(doc, commissions.financial)) : first.rows.map(doc => normalizeRecord(doc, kind, report));
  const value = { ownerId: report.value.ownerId, revision, items: all ? rows : rows.slice((page - 1) * limit, page * limit), page, limit, total: rows.length, pages: Math.ceil(rows.length / limit), kind };
  return { value, async verify() {
    if (fingerprint(first) !== fingerprint(await records(input))) fail(409, 'CHANGED');
    if (commissions) await commissions.financial.verify();
    await report.verify();
  } };
}
async function listFinance(input = {}, req) {
  const read = await beginFinance(input, req); await read.verify(); return read.value;
}
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
async function exportFinance(input, res, req) {
  const read = await beginFinance(input, req, { all: true });
  const columns = ['id', 'kind', 'createdAt', 'recordedAt', 'caseId', 'title', 'status', 'state', 'basis', 'currency', 'amount', 'requestedAmount', 'reference', 'stripeMode', ...(read.value.kind === 'commissions' ? ['earnedAmount', 'recordedPaidAmount', 'recordId'] : [])];
  const csv = [columns.map(csvCell).join(','), ...read.value.items.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\n') + '\n';
  // Finish the bounded read and all authority/source checks before any bytes
  // leave the process. A CSV cannot retract an earlier streamed private row.
  await read.verify();
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lpc-${read.value.kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('X-LPC-Financial-Owner', read.value.ownerId);
  res.setHeader('X-LPC-Financial-Revision', read.value.revision);
  res.send(csv);
}
module.exports = { listFinance, exportFinance, beginFinance };
