const User = require('../models/User');
const Case = require('../models/Case');
const SupportTicket = require('../models/SupportTicket');
const PaymentOperation = require('../models/PaymentOperation');
const AuditLog = require('../models/AuditLog');
const withDecisionTurn = require('../utils/decisionTurn');
const {
  evaluateAttorneyAccountReadiness,
  evaluateParalegalAdmissionReadiness,
  evaluateParalegalPublicSearchReadiness
} = require('./readinessPolicy');
const {
  projectPayoutReadiness
} = require('./paralegalReadinessService');
const {
  replyByEmail
} = require('./support/adminInboxService');
const activeStatuses = ['open', 'in_review', 'waiting_on_user', 'waiting_on_info'];
const activeMatterStatuses = ['in progress', 'in_progress', 'paused', 'disputed'];
const parties = id => ({
  $or: ['attorney', 'attorneyId', 'paralegal', 'paralegalId'].map(key => ({
    [key]: id
  }))
});
async function getAccountContext(id) {
  const user = await User.findById(id).select('-password').lean();
  if (!user) return null;
  const related = parties(user._id);
  const [matters, activeMatters, openInquiries, history, admissionRequests] = await Promise.all([Case.find(related).select('title status paymentStatus paymentReleased deadlineDate updatedAt').sort({
    updatedAt: -1
  }).limit(10).lean(), Case.countDocuments({
    ...related,
    status: {
      $in: activeMatterStatuses
    }
  }), SupportTicket.countDocuments({
    requesterUserId: user._id,
    status: {
      $in: activeStatuses
    }
  }), AuditLog.find({
    targetType: 'user',
    targetId: user._id
  }).select('action actorName createdAt meta').sort({
    createdAt: -1
  }).limit(30).lean(), SupportTicket.find({
    requesterUserId: user._id,
    administrativeRequestKey: {
      $exists: true
    }
  }).select('subject status nextAction emailReplies createdAt updatedAt').sort({
    createdAt: -1
  }).limit(10).lean()]);
  const caseIds = await Case.find(related).select('_id').lean();
  const moneyExceptions = await PaymentOperation.countDocuments({
    caseId: {
      $in: caseIds.map(item => item._id)
    },
    status: {
      $in: ['failed', 'needs_reconciliation', 'pending']
    }
  });
  const readiness = user.role === 'attorney' ? evaluateAttorneyAccountReadiness(user) : user.role === 'paralegal' ? evaluateParalegalAdmissionReadiness(user) : {
    ready: true,
    missing: [],
    reasons: []
  };
  const visibility = user.role === 'paralegal' ? evaluateParalegalPublicSearchReadiness(user) : null;
  const payouts = user.role === 'paralegal' ? projectPayoutReadiness({
    accountId: user.stripeAccountId,
    detailsSubmitted: user.stripeOnboarded,
    chargesEnabled: user.stripeChargesEnabled,
    payoutsEnabled: user.stripePayoutsEnabled,
    evidenceState: 'unknown',
    source: 'stored_not_live'
  }) : null;
  return {
    readiness,
    preparation: require('./adminPreparationService').prepareApplication(user, readiness),
    visibility,
    payouts,
    paymentMethod: {
      recordPresent: Boolean(user.stripeCustomerId),
      evidence: 'A customer record does not verify a usable payment method.'
    },
    activeMatters,
    openInquiries,
    moneyExceptions,
    matters,
    history,
    admissionRequests,
    reviewState: admissionRequests.find(ticket => activeStatuses.includes(ticket.status)) ? 'information_requested' : 'ready_for_review',
    documents: {
      resume: Boolean(user.resumeURL),
      certificate: Boolean(user.certificateURL)
    },
    checkedAt: new Date()
  };
}
function requestAdmissionInformation(options) {
  const { id, requestId, adminUser = {} } = options;
  return withDecisionTurn(`admission:${id}:${requestId}:${adminUser._id || adminUser.id}`, () => sendAdmissionInformation(options));
}
async function sendAdmissionInformation({
  id,
  requestId,
  text,
  adminUser,
  req,
  write
}) {
  if (!/^[a-f0-9-]{36}$/i.test(String(requestId || ''))) throw Object.assign(new Error('A valid request ID is required.'), {
    statusCode: 400
  });
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) throw Object.assign(new Error('Enter the information you need from this applicant.'), {
    statusCode: 400
  });
  const user = await User.findById(id);
  if (!user) throw Object.assign(new Error('Account not found.'), {
    statusCode: 404
  });
  if (user.status !== 'pending' || user.deleted) throw Object.assign(new Error('Information requests are available for pending applications.'), {
    statusCode: 409
  });
  const key = `admission:${user._id}:${requestId}`;
  const persistTicket = async (session, receiptOnlyError) => {
    if (receiptOnlyError) {
      let query = SupportTicket.findOne({ administrativeRequestKey: key });
      if (session) query = query.session(session);
      const recorded = await query;
      if (!recorded) throw receiptOnlyError;
      return recorded;
    }
    try {
      return await SupportTicket.findOneAndUpdate({ administrativeRequestKey: key }, {
        $setOnInsert: {
          createdAt: new Date(), updatedAt: new Date(), subject: 'Application information requested', message: text.trim(),
          requesterUserId: user._id, userId: user._id, requesterEmail: user.email, requesterRole: user.role,
          sourceSurface: 'admin', sourceLabel: 'Application review', assignedTo: adminUser._id || adminUser.id,
          nextAction: 'Review the applicant’s response.', requestKind: 'support'
        }
      }, { upsert: true, timestamps: false, returnDocument: 'after', runValidators: true, ...(session ? { session } : {}) });
    } catch (error) {
      if (session || error.code !== 11000) throw error;
      return SupportTicket.findOne({ administrativeRequestKey: key });
    }
  };
  let ticket;
  try { ticket = write ? await write(session => persistTicket(session), user) : await persistTicket(); }
  catch (error) {
    if (!write || !(error.code === 11000 || error.publicCode === 'ACCOUNT_WRITE_CHANGED')) throw error;
    // A concurrent matching request may recover its committed ticket under
    // fresh authority; this does not repeat a new ticket creation.
    ticket = await write(session => persistTicket(session, error), user);
  }
  const result = await replyByEmail({
    ticket,
    adminUser,
    text: text.trim(),
    status: 'waiting_on_user',
    requestId,
    write: write ? work => write(work, user) : undefined
  });
  if (!result.reused) await AuditLog.logFromReq(req, 'admin.user.information_requested', {
    targetType: 'user',
    targetId: user._id,
    meta: {
      ticketId: ticket._id,
      delivery: result.delivery
    }
  });
  return {
    ...result,
    ticketId: String(ticket._id)
  };
}
module.exports = {
  getAccountContext,
  requestAdmissionInformation
};
