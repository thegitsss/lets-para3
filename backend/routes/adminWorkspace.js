const router = require('express').Router();
const mongoose = require('mongoose');
const verifyToken = require('../utils/verifyToken');
const {
  requireApproved,
  requireRole
} = require('../utils/authz');
const Case = require('../models/Case');
const User = require('../models/User');
const CaseFile = require('../models/CaseFile');
const SupportTicket = require('../models/SupportTicket');
const AuditLog = require('../models/AuditLog');
const {
  csrfProtection
} = require('../utils/csrf');
const {
  getAccountContext,
  requestAdmissionInformation
} = require('../services/adminAccountService');
const {
  listFinance,
  beginFinance,
  exportFinance
} = require('../services/adminFinanceService');
const Application = require('../models/Application');
const Job = require('../models/Job');
const {
  buildMatterExperience
} = require('../services/matterExperience');
const Event = require('../models/Event');
const {
  listInbox
} = require('../services/support/adminInboxService');
const PaymentOperation = require('../models/PaymentOperation');
const financialAccount = require('../services/financialAccountBoundary');
const { fingerprint } = require('../services/matterDraftRevision');
const {
  previewDispute
} = require('../services/disputePreviewService');
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
router.use(verifyToken, requireApproved, requireRole('admin'));
router.get('/activity', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'no-store').json(await require('../services/adminActivityService').readAdminActivity());
}));
router.get('/flow', asyncHandler(async (req, res) => {
  const { nextAdminTask } = require('../services/adminFlowService');
  res.set('Cache-Control', 'no-store').json(await nextAdminTask({ owner: req.user.id || req.user._id, deferred: req.query.deferred, current: req.query.current, selected: req.query.selected, page: req.query.page }));
}));
router.put('/flow/follow-up', csrfProtection, asyncHandler(async (req, res) => {
  const { saveFollowUp } = require('../services/adminFlowService');
  const { key, sourceRevision, followUpAt, revision } = req.body || {};
  res.set('Cache-Control', 'no-store').json(await saveFollowUp({ owner: req.user.id || req.user._id, key, sourceRevision, followUpAt, revision }));
}));
router.get('/communications', asyncHandler(async (_req,res) => {
  const { mailboxStatus } = require('../services/support/mailboxSyncService');
  const { alertStatus } = require('../services/adminAlertService');
  const { noticeStatus } = require('../services/matterFileNotifications');
  const { noticeStatus: workNoticeStatus } = require('../services/matterWorkNotifications');
  const { noticeStatus: paymentNoticeStatus } = require('../services/matterPaymentNotifications');
  const { noticeStatus: withdrawalNoticeStatus } = require('../services/matterWithdrawalNotifications');
  const { noticeStatus: applicationNoticeStatus } = require('../services/matterApplicationNotifications');
  const { noticeStatus: invitationNoticeStatus } = require('../services/matterInvitationNotifications');
  const { noticeStatus: postingNoticeStatus } = require('../services/matterPostingNotifications');
  const { noticeStatus: preEngagementNoticeStatus } = require('../services/matterPreEngagementNotifications');
  const { noticeStatus: reviewNoticeStatus } = require('../services/matterReviewNotifications');
  const [mailbox,alerts,fileNotices,workNotices,paymentNotices,withdrawalNotices,reviewNotices,applicationNotices,invitationNotices,preEngagementNotices,postingNotices]=await Promise.all([mailboxStatus(),alertStatus(),noticeStatus(),workNoticeStatus(),paymentNoticeStatus(),withdrawalNoticeStatus(),reviewNoticeStatus(),applicationNoticeStatus(),invitationNoticeStatus(),preEngagementNoticeStatus(),postingNoticeStatus()]);
  res.set('Cache-Control','no-store').json({mailbox,alerts,fileNotices,workNotices,paymentNotices,withdrawalNotices,reviewNotices,applicationNotices,invitationNotices,preEngagementNotices,postingNotices});
}));
router.post('/communications/sync', csrfProtection, asyncHandler(async (_req,res) => {
  const { syncMailbox } = require('../services/support/mailboxSyncService');
  res.json(await syncMailbox({maxMessages:20}));
}));
router.post('/communications/alerts/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Alert=require('../models/AdminCommunicationAlert');
  res.json(await require('../services/communicationRetry').retry(req,Alert,'owner_alert'));
}));
router.post('/communications/files/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterFileNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_file'));
}));
router.post('/communications/work/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterWorkNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_work'));
}));
router.post('/communications/payments/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterPaymentNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_payment'));
}));
router.post('/communications/withdrawals/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterWithdrawalNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_withdrawal'));
}));
router.post('/communications/applications/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterApplicationNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_application'));
}));
router.post('/communications/invitations/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterInvitationNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_invitation'));
}));
router.post('/communications/posting/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterPostingNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_posting'));
}));
router.post('/communications/pre-engagement/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterPreEngagementNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_pre_engagement'));
}));
router.post('/communications/reviews/:id/retry', csrfProtection, asyncHandler(async (req,res) => {
  const Notice=require('../models/MatterReviewNotification');
  res.json(await require('../services/communicationRetry').retry(req,Notice,'matter_review'));
}));
router.get('/drafts/:kind/:recordId', asyncHandler(async (req,res) => {
  const { loadDraft } = require('../services/adminDraftService');
  res.set('Cache-Control','no-store').json(await loadDraft({ ...req.params, owner:req.user.id || req.user._id }));
}));
router.put('/drafts/:kind/:recordId', csrfProtection, asyncHandler(async (req,res) => {
  const { saveDraft } = require('../services/adminDraftService');
  res.set('Cache-Control','no-store').json(await saveDraft({ ...req.params, owner:req.user.id || req.user._id },req.body));
}));
router.get('/finance/records', asyncHandler(async (req, res) => res.set('Cache-Control', 'private, no-store').json(await listFinance(req.query, req))));
router.get('/finance/export', asyncHandler(async (req, res) => exportFinance(req.query, res, req)));
router.get('/finance/dispute-preview/:id', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    error: 'Invalid matter ID.'
  });
  res.json(await previewDispute({
    ...req.query,
    caseId: req.params.id
  }));
}));
router.get('/inquiries/:id/preparation', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid inquiry ID.' });
  res.set('Cache-Control', 'no-store').json(await require('../services/adminPreparationService').prepareInquiry(req.params.id));
}));
router.get('/accounts/:id', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    error: 'Invalid account ID.'
  });
  const context = await getAccountContext(req.params.id);
  if (!context) return res.status(404).json({
    error: 'Account not found.'
  });
  res.json(context);
}));
router.post('/accounts/:id/information-request', csrfProtection, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    error: 'Invalid account ID.'
  });
  res.json(await requestAdmissionInformation({
    id: req.params.id,
    requestId: req.body?.requestId,
    text: req.body?.text,
    adminUser: req.user,
    req
  }));
}));
router.post('/accounts/:id/note', csrfProtection, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id) || !(await User.exists({
    _id: req.params.id
  }))) return res.status(404).json({
    error: 'Account not found.'
  });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text || text.length > 4000) return res.status(400).json({
    error: 'Enter a note up to 4,000 characters.'
  });
  await AuditLog.logFromReq(req, 'admin.user.note_added', {
    targetType: 'user',
    targetId: req.params.id,
    meta: {
      note: text
    }
  });
  res.json({
    ok: true
  });
}));
router.get('/attention', asyncHandler(async (_req, res) => {
  const today = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York'
  });
  const [money, chargebacks, overdue, stalled] = await Promise.all([PaymentOperation.countDocuments({
    kind: {
      $ne: 'chargeback'
    },
    status: {
      $in: ['failed', 'needs_reconciliation']
    }
  }), PaymentOperation.countDocuments({
    kind: 'chargeback',
    administrativeStatus: {
      $in: ['pending_review', 'acknowledged', null]
    }
  }), Case.countDocuments({
    status: {
      $in: ['open', 'in progress', 'in_progress', 'paused']
    },
    deadlineDate: {
      $lt: today
    }
  }), Case.countDocuments({
    $or: [{
      postingSyncStatus: 'needs_reconciliation'
    }, {
      hiringClaimStatus: 'needs_reconciliation'
    }, {
      completionClaimStatus: 'needs_reconciliation'
    }, {
      fundingIntegrityStatus: 'failed'
    }]
  })]);
  res.json({
    money,
    chargebacks,
    overdue,
    stalled,
    checkedAt: new Date()
  });
}));
const fields = 'title details briefSummary practiceArea locationState state status moderationStatus archived attorney attorneyId paralegal paralegalId paralegalNameSnapshot createdAt updatedAt deadline deadlineDate totalAmount lockedTotalAmount currency paymentStatus escrowStatus paymentReleased payoutFinalizedAt payoutTransferId relistRequestedAt terminationStatus tasks jobId flags hiredAt pausedAt pausedReason completedAt disputeDeadlineAt disputes.createdAt preEngagement.status preEngagement.requestedAt preEngagement.submittedAt preEngagement.reviewedAt withdrawalHistory terminatedAt terminationRequestedAt remainingAmount fundingIntegrityStatus payoutStatus postingSyncStatus hiringClaimStatus completionClaimStatus applicants.paralegalId applicants.status applicants.appliedAt';
const populate = query => query.populate('attorney', 'firstName lastName email').populate('attorneyId', 'firstName lastName email').populate('paralegal', 'firstName lastName email').populate('paralegalId', 'firstName lastName email');
function safeMatter(doc) {
  const {
    _id,
    title,
    details,
    briefSummary,
    practiceArea,
    locationState,
    state,
    status,
    moderationStatus,
    archived,
    attorney,
    attorneyId,
    paralegal,
    paralegalId,
    paralegalNameSnapshot,
    createdAt,
    updatedAt,
    deadline,
    deadlineDate,
    totalAmount,
    lockedTotalAmount,
    currency,
    paymentStatus,
    escrowStatus,
    paymentReleased,
    payoutFinalizedAt,
    relistRequestedAt,
    terminationStatus,
    tasks
  } = doc;
  return {
    id: String(_id),
    title,
    description: details || briefSummary || '',
    practiceArea,
    location: locationState || state,
    status,
    moderationStatus,
    archived,
    attorney: attorney || attorneyId,
    paralegal: paralegal || paralegalId,
    paralegalNameSnapshot,
    createdAt,
    updatedAt,
    deadline: deadlineDate || deadline,
    totalAmount,
    lockedTotalAmount,
    currency,
    paymentStatus,
    escrowStatus,
    paymentReleased,
    payoutFinalizedAt,
    relistRequestedAt,
    terminationStatus,
    tasks: (tasks || []).map(t => ({
      title: t.title,
      status: t.status,
      completed: t.completed,
      completedAt: t.completedAt
    })),
    flags: (doc.flags || []).map(f => ({
      reason: f.reason,
      details: f.details,
      createdAt: f.createdAt
    })),
    flagCount: (doc.flags || []).length,
    workflow: {
      hiredAt: doc.hiredAt,
      pausedAt: doc.pausedAt,
      pausedReason: doc.pausedReason,
      completedAt: doc.completedAt,
      disputeDeadlineAt: doc.disputeDeadlineAt,
      preEngagement: doc.preEngagement,
      terminatedAt: doc.terminatedAt,
      terminationRequestedAt: doc.terminationRequestedAt,
      remainingAmount: doc.remainingAmount,
      fundingIntegrityStatus: doc.fundingIntegrityStatus,
      payoutStatus: doc.payoutStatus,
      postingSyncStatus: doc.postingSyncStatus,
      hiringClaimStatus: doc.hiringClaimStatus,
      completionClaimStatus: doc.completionClaimStatus,
      withdrawals: (doc.withdrawalHistory || []).map(h => ({
        paralegalName: h.paralegalNameSnapshot,
        pausedAt: h.pausedAt,
        finalizedAt: h.payoutFinalizedAt,
        payoutType: h.payoutFinalizedType,
        amount: h.partialPayoutAmount,
        remaining: h.remainingAmount
      }))
    }
  };
}
router.get('/matters', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1),
    limit = 20,
    query = {};
  const filter = String(req.query.filter || 'all');
  if (filter === 'open') Object.assign(query, {
    status: 'open',
    archived: {
      $ne: true
    }
  });
  if (filter === 'active') query.status = {
    $in: ['in progress', 'in_progress', 'in-progress', 'reviewing', 'paused']
  };
  if (filter === 'overdue') {
    query.status = {
      $in: ['open', 'in progress', 'in_progress', 'paused']
    };
    query.deadlineDate = {
      $lt: new Date().toLocaleDateString('en-CA', {
        timeZone: 'America/New_York'
      })
    };
  }
  if (filter === 'stalled') query.$or = [{
    postingSyncStatus: 'needs_reconciliation'
  }, {
    hiringClaimStatus: 'needs_reconciliation'
  }, {
    completionClaimStatus: 'needs_reconciliation'
  }, {
    fundingIntegrityStatus: 'failed'
  }];
  if (filter === 'completed') query.status = {
    $in: ['completed', 'closed']
  };
  if (filter === 'archived') query.archived = true;
  if (filter === 'disputed') query.$or = [{
    status: 'disputed'
  }, {
    'disputes.status': 'open'
  }];
  if (filter === 'review') query.$or = [{
    moderationStatus: {
      $in: ['flagged', 'resolution_requested']
    }
  }, {
    'flags.0': {
      $exists: true
    }
  }];
  if (req.query.user && mongoose.isValidObjectId(req.query.user)) query.$and = [{
    $or: ['attorney', 'attorneyId', 'paralegal', 'paralegalId'].map(key => ({
      [key]: req.query.user
    }))
  }];
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const users = await User.find({
      $or: [{
        firstName: rx
      }, {
        lastName: rx
      }, {
        email: rx
      }]
    }).select('_id').lean();
    const clauses = [{
      title: rx
    }, ...['attorney', 'attorneyId', 'paralegal', 'paralegalId'].map(key => ({
      [key]: {
        $in: users.map(u => u._id)
      }
    }))];
    if (mongoose.isValidObjectId(q)) clauses.push({
      _id: q
    });
    query.$and = [...(query.$and || []), {
      $or: clauses
    }];
  }
  const [docs, total] = await Promise.all([populate(Case.find(query).select(fields).sort({
    createdAt: -1,
    _id: -1
  }).skip((page - 1) * limit).limit(limit)).lean(), Case.countDocuments(query)]);
  res.json({
    items: docs.map(safeMatter),
    total,
    page,
    pages: Math.ceil(total / limit)
  });
}));
router.get('/matters/:id', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    error: 'Invalid matter ID.'
  });
  const financialRead = await require('../services/adminFinancialReport').begin(req, { caseId: req.params.id });
  const doc = await populate(Case.findById(req.params.id).select(fields)).lean();
  if (!doc) return res.status(404).json({
    error: 'Matter not found.'
  });
  const [files, tickets, activity] = await Promise.all([CaseFile.aggregate([{
    $match: {
      caseId: doc._id
    }
  }, {
    $group: {
      _id: '$status',
      count: {
        $sum: 1
      }
    }
  }]), SupportTicket.find({
    caseId: doc._id
  }).select('subject status requestKind updatedAt').sort({
    updatedAt: -1
  }).limit(20).lean(), AuditLog.find({
    $or: [{
      case: doc._id
    }, {
      targetType: 'case',
      targetId: doc._id
    }]
  }).select('action createdAt').sort({
    createdAt: -1
  }).limit(20).lean()]);
  await financialRead.verify();
  res.set('Cache-Control', 'private, no-store').json({
    matter: safeMatter(doc),
    files,
    tickets,
    payouts: financialRead.value.payouts,
    financial: { ownerId: financialRead.value.ownerId, revision: financialRead.value.revision, balance: financialRead.value.matters[0] || null, held: financialRead.value.held, funding: financialRead.value.funding, income: financialRead.value.income, payoutTotals: financialRead.value.payoutTotals, incomeTotals: financialRead.value.incomeTotals },
    activity,
    timeline: buildMatterExperience(doc, {
      viewer: req.user,
      acl: {
        isAdmin: true
      }
    }).activity
  });
}));
router.get('/matters/:id/records', asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({
    error: 'Invalid matter ID.'
  });
  const doc = await Case.findById(req.params.id).select('jobId applicants.paralegalId applicants.status applicants.appliedAt').lean();
  if (!doc) return res.status(404).json({
    error: 'Matter not found.'
  });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1),
    limit = 20,
    type = String(req.query.type || 'files');
  let Model,
    query,
    fields,
    population = null;
  if (type === 'applications') {
    Model = Application;
    const jobs = await Job.find({
      caseId: doc._id
    }).select('_id').lean();
    query = {
      $or: [{
        jobId: {
          $in: [...jobs.map(j => j._id), doc.jobId].filter(Boolean)
        }
      }, {
        'scopeSnapshot.caseId': String(doc._id)
      }]
    };
    fields = 'paralegalId status createdAt updatedAt syncStatus';
    population = ['paralegalId', 'firstName lastName email'];
  } else if (type === 'files') {
    Model = CaseFile;
    query = {
      caseId: doc._id
    };
    fields = 'originalName status uploadedByRole createdAt updatedAt securityStatus version';
  } else if (type === 'deadlines') {
    Model = Event;
    query = {
      caseId: doc._id,
      visibility: {
        $ne: 'private'
      }
    };
    fields = 'title start end isAllDay type visibility';
  } else if (type === 'activity') {
    Model = AuditLog;
    query = {
      $or: [{
        case: doc._id
      }, {
        targetType: 'case',
        targetId: String(doc._id)
      }]
    };
    fields = 'action createdAt targetType targetId';
  } else return res.status(400).json({
    error: 'Unknown matter record view.'
  });
  let list = Model.find(query).select(fields).sort({
    createdAt: -1,
    _id: -1
  }).skip((page - 1) * limit).limit(limit);
  if (population) list = list.populate(...population);
  const [items, total] = await Promise.all([list.lean(), Model.countDocuments(query)]);
  res.json({
    items,
    total,
    page,
    pages: Math.ceil(total / limit),
    type,
    legacyApplicants: type === 'applications' ? (doc.applicants || []).map(a => ({
      paralegalId: a.paralegalId,
      status: a.status,
      appliedAt: a.appliedAt
    })) : []
  });
}));
router.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 2) {
    const owner = await financialAccount.read(req, 'admin', req.query.expectedOwnerId);
    return res.set('Cache-Control', 'private, no-store').json({ ownerId: String(owner._id), revision: fingerprint([owner, q]), users: [], matters: [], tickets: [], payments: [] });
  }
  const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const userOr = [{
    firstName: rx
  }, {
    lastName: rx
  }, {
    email: rx
  }];
  const matterOr = [{
    title: rx
  }];
  if (mongoose.isValidObjectId(q)) {
    userOr.push({
      _id: q
    });
    matterOr.push({
      _id: q
    });
  }
  const [users, matters, tickets, payments] = await Promise.all([User.find({
    $or: userOr
  }).select('firstName lastName email role status').limit(8).lean(), Case.find({
    $or: matterOr
  }).select('title status').limit(8).lean(), listInbox({
    q,
    status: 'all',
    limit: 8
  }), beginFinance({
    q,
    limit: 8,
    kind: 'operations'
  }, req)]);
  await payments.verify();
  res.set('Cache-Control', 'private, no-store').json({
    ownerId: payments.value.ownerId,
    revision: payments.value.revision,
    users,
    matters,
    tickets: tickets.tickets.map(t => ({
      id: t.id,
      subject: t.subject,
      reference: t.reference
    })),
    payments: payments.value.items
  });
}));
router.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const proposed = Number(error.statusCode || error.status);
  const status = proposed >= 400 && proposed < 600 ? proposed : 500;
  res.status(status).json({ error: status < 500 ? error.message : 'Admin workspace is temporarily unavailable. Please try again.' });
});
module.exports = router;
