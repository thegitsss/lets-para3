const Notice = require('../models/MatterInvitationNotification');
const Case = require('../models/Case'), User = require('../models/User');
const { one, id } = require('./applicationIdentity');
const { fingerprint } = require('./matterDraftRevision');
const { caseParticipantIdentity } = require('../utils/caseParticipantIdentity');
const { isBlockedBetween } = require('../utils/blocks');
const { evaluateInvitationEligibility } = require('./attorneyWorkflowPolicy');
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const approved = (user, role) => user?.role === role && user.status === 'approved' && !user.deleted && !user.disabled && !user.suspended;

function invitationKey(matter, ownerId, paralegalId) {
  const identity = caseParticipantIdentity(matter || {}, ownerId);
  if (!identity.isAttorney || identity.identityConflict) return null;
  const entries = (matter.invites || []).filter(entry => id(entry.paralegalId) === id(paralegalId));
  if (entries.length !== 1) return null;
  const invite = entries[0];
  if (invite.status !== 'pending' || !date(invite.invitedAt) || invite.respondedAt || invite.syncStatus !== 'synced') return null;
  return fingerprint(['sent', id(matter._id), id(ownerId), id(paralegalId), date(invite.invitedAt), matter.lockedTotalAmount, date(matter.amountLockedAt)]);
}

async function ready() {
  const indexes = await Notice.collection.indexes();
  const has = (key, unique = false) => indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key) && (!unique || index.unique));
  if (!has({ caseId: 1, invitationKey: 1, kind: 1, userId: 1 }, true) || !has({ status: 1, nextAttemptAt: 1, createdAt: 1, _id: 1 })) throw new Error('Invitation notification delivery indexes are unavailable.');
}

async function stage({ caseId, ownerId, userId, actorUserId, invitedAt }, session) {
  if (!session?.inTransaction()) throw new Error('Invitation email requires the invitation transaction.');
  await ready();
  const matter = await one(Case, caseId, undefined, session);
  const key = invitationKey(matter, ownerId, userId);
  const invite = matter?.invites?.find(entry => id(entry.paralegalId) === id(userId));
  if (!key || date(invite?.invitedAt) !== date(invitedAt)) throw new Error('Invitation notification generation could not be verified.');
  await Notice.create([{ kind: 'sent', caseId, invitationKey: key, userId, ownerId, actorUserId, paralegalId: userId }], { session });
}

async function retainSent(result, { caseId, paralegalId, actorUserId, invitedAt }, session) {
  if (!result.sent) return result;
  try {
    const matter = await one(Case, caseId, undefined, session);
    const ownerId = id(matter?.attorney || matter?.attorneyId);
    if (!invitationKey(matter, ownerId, paralegalId)) throw new Error('Invitation recipient could not be verified.');
    const { notifyUser } = require('../utils/notifyUser');
    const options = { session, deferDispatch: true, actorUserId };
    const payload = { caseId: matter._id, caseTitle: matter.title || 'Untitled Matter' };
    const dispatches = [];
    if (result.lockedNow) dispatches.push(await notifyUser(ownerId, 'case_budget_locked', { ...payload, link: `case-detail.html?caseId=${encodeURIComponent(id(matter._id))}` }, options));
    dispatches.push(await notifyUser(paralegalId, 'case_invite', payload, {
      ...options, invitationSent: { ownerId, invitedAt },
    }));
    if (dispatches.some(dispatch => typeof dispatch !== 'function')) throw new Error('Invitation recipient was not available.');
    return { ...result, dispatch: async () => { for (const dispatch of dispatches) await dispatch(); } };
  } catch (cause) {
    throw Object.assign(new Error('The invitation could not be saved with its notices. Review the Matter before trying again.'), {
      status: 503, statusCode: 503, publicCode: 'INVITATION_NOTICE_UNAVAILABLE', cause,
    });
  }
}

function responseKey(matter, ownerId, paralegalId, kind) {
  if (!['accepted', 'declined', 'revoked'].includes(kind)) return null;
  const identity = caseParticipantIdentity(matter || {}, ownerId);
  if (!identity.isAttorney || identity.identityConflict) return null;
  const entries = (matter.invites || []).filter(entry => id(entry.paralegalId) === id(paralegalId));
  if (entries.length !== 1) return null;
  const invite = entries[0];
  if (invite.status !== (kind === 'accepted' ? 'accepted' : 'declined') || !date(invite.respondedAt)) return null;
  // Earlier invitations can have no invitation date. Keep that absence rather
  // than fabricating a generation or making the response incompatible.
  return fingerprint([kind, id(matter._id), id(ownerId), id(paralegalId), date(invite.invitedAt), date(invite.respondedAt)]);
}

function responseMessage({ kind, matter, paralegal, actor, self }) {
  const title = matter.title || 'this Matter';
  const name = `${paralegal.firstName || ''} ${paralegal.lastName || ''}`.trim() || 'The invited paralegal';
  if (actor.role === 'admin') {
    const administrator = `${actor.firstName || ''} ${actor.lastName || ''}`.trim();
    return `${administrator ? `LPC administrator ${administrator}` : 'An LPC administrator'} recorded ${self ? 'your' : `${name}’s`} ${kind === 'accepted' ? 'acceptance' : kind === 'revoked' ? 'withdrawal from consideration' : 'decline'} of the invitation for ${title}.`;
  }
  if (kind === 'revoked') return `${self ? 'You withdrew' : `${name} withdrew`} from consideration for ${title}.`;
  return `${self ? 'You' : name} ${kind === 'accepted' ? 'accepted' : 'declined'} ${self ? 'the' : 'your'} invitation for ${title}.`;
}

async function stageResponse({ caseId, ownerId, paralegalId, userId, actorUserId, kind }, session) {
  if (!session?.inTransaction()) throw new Error('Invitation response email requires the response transaction.');
  await ready();
  const matter = await one(Case, caseId, undefined, session);
  const key = responseKey(matter, ownerId, paralegalId, kind);
  if (!key || ![id(ownerId), ...(kind === 'accepted' ? [] : [id(paralegalId)])].includes(id(userId))) throw new Error('Invitation response recipient could not be verified.');
  await Notice.create([{ kind, caseId, invitationKey: key, userId, ownerId, actorUserId, paralegalId }], { session });
}

async function retainResponse({ caseId, paralegalId, actorUserId, kind }, session) {
  try {
    const matter = await one(Case, caseId, undefined, session);
    const ownerId = id(matter?.attorney || matter?.attorneyId);
    const paralegal = await one(User, paralegalId, undefined, session);
    const actor = await one(User, actorUserId, undefined, session);
    if (!paralegal || !actor || !responseKey(matter, ownerId, paralegalId, kind)
      || !(id(actor._id) === id(paralegalId) || approved(actor, 'admin'))) throw new Error('Invitation response could not be verified.');
    const dispatches = [];
    for (const userId of [ownerId, ...(kind === 'accepted' ? [] : [paralegalId])]) {
      const message = responseMessage({ kind, matter, paralegal, actor, self: id(userId) === id(paralegalId) });
      const dispatch = await require('../utils/notifyUser').notifyUser(userId, 'case_invite_response', {
        caseId: matter._id, caseTitle: matter.title || 'Untitled Matter', paralegalId,
        paralegalName: `${paralegal.firstName || ''} ${paralegal.lastName || ''}`.trim() || 'The invited paralegal',
        response: kind === 'accepted' ? 'accepted' : 'declined',
        message: message + (kind === 'accepted' ? ' Confirm the hire and fund the Matter to get started.' : ''),
      }, { actorUserId, session, deferDispatch: true, invitationResponse: { ownerId, kind } });
      if (typeof dispatch !== 'function') throw new Error('Invitation response recipient was not available.');
      dispatches.push(dispatch);
    }
    return async () => { for (const dispatch of dispatches) await dispatch(); };
  } catch (cause) {
    throw Object.assign(new Error('Your invitation response could not be saved with its notices. Review the invitation before trying again.'), {
      status: 503, statusCode: 503, publicCode: 'INVITATION_RESPONSE_NOTICE_UNAVAILABLE', cause,
    });
  }
}

async function prepareResponse(notice) {
  const [matter, owner, paralegal, actor] = await Promise.all([
    one(Case, notice.caseId), one(User, notice.ownerId), one(User, notice.paralegalId), one(User, notice.actorUserId),
  ]);
  const self = id(notice.userId) === id(notice.paralegalId);
  const recipient = self ? paralegal : owner;
  if (!matter || responseKey(matter, notice.ownerId, notice.paralegalId, notice.kind) !== notice.invitationKey
    || !(id(notice.userId) === id(notice.ownerId) || self && notice.kind !== 'accepted')
    || !approved(owner, 'attorney') || !approved(paralegal, 'paralegal')
    || !(id(actor?._id) === id(paralegal._id) || approved(actor, 'admin'))
    || matter.purgedAt || matter.archived || matter.readOnly || matter.paymentReleased
    || matter.paralegal || matter.paralegalId || matter.hiringClaimToken || matter.hiringClaimStatus
    || ['closed', 'completed', 'complete', 'cancelled', 'canceled', 'disputed'].includes(matter.status)
    || !require('../utils/notifyUser').shouldSendEmailForType(recipient, 'case_invite_response')
    || await isBlockedBetween(notice.ownerId, notice.paralegalId)) return null;
  const invite = matter.invites.find(entry => id(entry.paralegalId) === id(notice.paralegalId));
  // Do not deliver "continue hiring" before the canonical application exists.
  // Throwing before SMTP preserves a retryable obligation while it reconciles.
  if (invite.syncStatus !== 'synced') throw new Error('Invitation response reconciliation has not finished.');
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(recipient.email || '')) throw new Error('Recipient email unavailable.');
  return { to: recipient.email, ...require('../email/templates').caseInvitationResponse({
    kind: notice.kind, caseId: notice.caseId, paralegalId: notice.paralegalId, self,
    message: responseMessage({ kind: notice.kind, matter, paralegal, actor, self }),
  }) };
}

async function prepare(notice) {
  if (['accepted', 'declined', 'revoked'].includes(notice.kind)) return prepareResponse(notice);
  if (notice.kind !== 'sent' || id(notice.userId) !== id(notice.paralegalId)) return null;
  const [matter, owner, invitee, actor] = await Promise.all([
    one(Case, notice.caseId), one(User, notice.ownerId), one(User, notice.paralegalId), one(User, notice.actorUserId),
  ]);
  if (!matter || invitationKey(matter, notice.ownerId, notice.paralegalId) !== notice.invitationKey
    || !approved(owner, 'attorney') || !approved(invitee, 'paralegal')
    || !(id(actor?._id) === id(owner._id) || approved(actor, 'admin'))
    || matter.archived || matter.readOnly || matter.purgedAt || matter.paymentReleased || matter.hiringClaimToken || matter.hiringClaimStatus
    || !require('../utils/notifyUser').shouldSendEmailForType(invitee, 'case_invite')
    || await isBlockedBetween(notice.ownerId, notice.paralegalId)) return null;
  // An invitation remains a request to consider the Matter. It must not be
  // delivered as current after assignment, closing or a superseding response.
  const policy = evaluateInvitationEligibility({ caseDoc: matter, ownerAuthorized: true, targetSelected: true, paralegalApproved: true, payoutSetupReady: true });
  if (!policy.ready) return null;
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(invitee.email || '')) throw new Error('Recipient email unavailable.');
  return { to: invitee.email, ...require('../email/templates').caseInvite({
    caseId: notice.caseId, caseTitle: matter.title || 'Untitled Matter',
    inviterName: `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || (actor.role === 'admin' ? 'An LPC administrator' : 'An attorney'),
  }) };
}

const { processNotices, noticeStatus } = require('./emailNoticeDelivery').createEmailNoticeDelivery({ Notice, prepare, prefix: 'invitation' });
module.exports = { ready, stage, retainSent, invitationKey, stageResponse, retainResponse, responseKey, processNotices, noticeStatus };
