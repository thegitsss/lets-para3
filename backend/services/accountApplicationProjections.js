const mongoose = require('mongoose');
const Application = require('../models/Application');
const Job = require('../models/Job');
const Case = require('../models/Case');
const User = require('../models/User');
const { getBlockedUserIds } = require('../utils/blocks');
const { buildAuthenticatedProfilePhotoUrl } = require('./profilePhotoDelivery');
const { findActiveSession } = require('./authSessionService');
const { fingerprint } = require('./matterDraftRevision');
const INVITE_STATUSES = new Set(['pending', 'accepted', 'declined', 'expired']);
const PENDING_STATUSES = new Set(['submitted', 'viewed', 'shortlisted']);
const id = value => String(value?._id || value || '').toLowerCase();
const status = value => String(value || '').trim().toLowerCase();
const fail = (httpStatus, publicCode, message) => { throw Object.assign(new Error(message), { status: httpStatus, publicCode }); };

const validId = value => /^[a-f0-9]{24}$/.test(id(value));
const refs = value => validId(value) ? [new mongoose.Types.ObjectId(id(value)), id(value), id(value).toUpperCase()] : [];
const invalid = () => fail(409, 'APPLICATION_SOURCE_INVALID', 'Application records need verification before this list can be shown.');
const fields = value => Object.fromEntries(value.split(' ').map(key => [key, 1]));
const matterFields = 'title practiceArea details briefSummary totalAmount lockedTotalAmount currency status archived createdAt updatedAt job jobId attorney attorneyId paralegal paralegalId applicants preEngagement invites paymentReleased escrowStatus readOnly relistPending hiredAt escrowIntentId paymentIntentId fundingRequestKey hiringClaimToken hiringClaimStatus hiringClaimPaymentIntentId';
const personFields = 'firstName lastName name email role status disabled deleted profileImage avatarURL';
async function raw(Model, query, selected) {
  const rows = await Model.collection.find(query, { ...(selected ? { projection: fields(selected) } : {}), maxTimeMS: 15000 }).sort({ _id: 1 }).toArray();
  const seen = new Set();
  for (const row of rows) { if (!validId(row._id) || seen.has(id(row._id))) invalid(); seen.add(id(row._id)); }
  return rows;
}
async function byIds(Model, values, selected) {
  const keys = [...new Set(values.filter(validId).map(id))];
  return new Map((keys.length ? await raw(Model, { _id: { $in: keys.flatMap(refs) } }, selected) : []).map(row => [id(row._id), row]));
}
function applicationIdentity(rows) {
  const seen = new Set();
  for (const row of rows) {
    if (!validId(row.jobId) || !validId(row.paralegalId)) invalid();
    const key = `${id(row.jobId)}:${id(row.paralegalId)}`;
    if (seen.has(key)) invalid(); seen.add(key);
  }
}
function ownerOf(doc) {
  if (!doc || !validId(doc.attorneyId || doc.attorney) || doc.attorneyId && doc.attorney && id(doc.attorneyId) !== id(doc.attorney)) invalid();
  return id(doc.attorneyId || doc.attorney);
}
function validateLink(job, matter) {
  if (!job || !matter) return;
  if (ownerOf(job) !== ownerOf(matter) || id(job.caseId) !== id(matter._id) || matter.job && matter.jobId && id(matter.job) !== id(matter.jobId) || (matter.jobId || matter.job) && id(matter.jobId || matter.job) !== id(job._id)) invalid();
}
function earlierRecords(doc) {
  if (doc.applicants != null && !Array.isArray(doc.applicants)) invalid();
  const records = doc.applicants || [], seen = new Set();
  for (const record of records) {
    if (!validId(record?.paralegalId) || seen.has(id(record.paralegalId))) invalid();
    seen.add(id(record.paralegalId));
  }
  return records;
}
function linkedPosting(doc, jobs) {
  const linked = doc.jobId || doc.job;
  if (doc.jobId && doc.job && id(doc.jobId) !== id(doc.job) || linked && !validId(linked)) invalid();
  const reverse = [...jobs.values()].filter(job => id(job.caseId) === id(doc._id));
  if (reverse.length > 1 || linked && reverse[0] && id(reverse[0]._id) !== id(linked)) invalid();
  const job = linked ? jobs.get(id(linked)) : reverse[0];
  validateLink(job, doc);
  return job;
}
function personReference(value, people) { const person = people.get(id(value)); return person ? { ...person, _id: id(person._id) } : value ? { _id: id(value) } : null; }
function safePerson(value) {
  if (!value || value.role !== 'paralegal' || value.status !== 'approved' || value.disabled || value.deleted) return value ? { _id: id(value) } : null;
  const { _id, firstName, lastName, email, role, profileImage, avatarURL } = value;
  return { _id: id(_id), firstName, lastName, email, role, profileImage, avatarURL };
}

async function assertAccount(req, role) {
  const actorId = id(req.user?.id || req.user?._id);
  if (!mongoose.isValidObjectId(actorId) || req.user?.role !== role || req.query?.expectedOwnerId !== undefined && req.query.expectedOwnerId !== actorId) fail(403, 'APPLICATION_ACCOUNT_CHANGED', 'The signed-in account changed. Sign in again to review applications.');
  const account = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(actorId) }, { projection: { role: 1, status: 1, disabled: 1, deleted: 1, authVersion: 1 } });
  if (!account || account.role !== role || account.status !== 'approved' || account.disabled || account.deleted || Number(account.authVersion || 0) !== Number(req.auth?.payload?.av || 0) || req.authSessionId && !await findActiveSession(req.authSessionId, actorId)) fail(403, 'APPLICATION_ACCOUNT_CHANGED', 'This account can no longer review applications.');
}

function openMatter(doc) {
  return !!doc && status(doc.status) === 'open' && doc.archived !== true && doc.paymentReleased !== true && status(doc.escrowStatus) !== 'funded' && !doc.paralegalId && !doc.paralegal;
}
function openPosting(job, matter) {
  return !!job && status(job.status) === 'open' && (!job.caseId || openMatter(matter));
}
function isPending(application) { return application.pending === true; }

function presentProfilePerson(person) {
  if (!person || typeof person !== "object") return person || null;
  const source = typeof person.toObject === "function" ? person.toObject() : person;
  const hasPhoto = Boolean(source.profileImage || source.avatarURL);
  const photoUrl = hasPhoto ? buildAuthenticatedProfilePhotoUrl(source) : "";
  return { ...source, profileImage: photoUrl, avatarURL: photoUrl };
}

function normalizeInviteStatus(value) {
  const key = String(value || "").toLowerCase();
  return INVITE_STATUSES.has(key) ? key : "pending";
}

function normalizeInviteParalegalId(value) {
  if (!value) return "";
  if (typeof value === "string") return id(value);
  if (typeof value === "object") {
    return id(value._id || value.id || value.userId);
  }
  return String(value);
}

async function getCaseApplicationsForAttorney(attorneyId, blockedSet, jobById) {
  const attorneyKey = id(attorneyId);
  const cases = await raw(Case, { $or: [{ attorneyId: { $in: refs(attorneyId) } }, { attorney: { $in: refs(attorneyId) } }], 'applicants.0': { $exists: true } }, matterFields);
  const linkedJobs = cases.length ? await raw(Job, { $or: [{ _id: { $in: cases.flatMap(doc => refs(doc.jobId || doc.job)) } }, { caseId: { $in: cases.flatMap(doc => refs(doc._id)) } }] }, 'attorneyId title practiceArea budget caseId status') : [];
  const allJobs = new Map([...jobById, ...linkedJobs.map(job => [id(job._id), job])]);
  const people = await byIds(User, cases.flatMap(doc => (Array.isArray(doc.applicants) ? doc.applicants : []).map(item => item.paralegalId)), personFields);

  const entries = [];
  cases.forEach((caseDoc) => {
    if (ownerOf(caseDoc) !== attorneyKey) invalid();
    const linked = caseDoc.jobId || caseDoc.job;
    const job = linkedPosting(caseDoc, allJobs);
    if (!openMatter(caseDoc) || linked && !job || job && !openPosting(job, caseDoc)) return;
    const amountCents = Number.isFinite(caseDoc.lockedTotalAmount)
      ? caseDoc.lockedTotalAmount
      : caseDoc.totalAmount;
    const budget = typeof amountCents === "number" ? amountCents / 100 : null;
    const caseId = id(caseDoc._id);
    const jobTitle = caseDoc.title || "Untitled Matter";
    const practiceArea = caseDoc.practiceArea || "";
    const fallbackDate = caseDoc.createdAt || null;
    earlierRecords(caseDoc).forEach((applicant) => {
      const status = String(applicant?.status || "unknown").toLowerCase();
      if (status !== "pending") return;
      const paralegalId = id(applicant.paralegalId);
      const paralegal = safePerson(personReference(paralegalId, people));
      if (blockedSet && paralegalId && blockedSet.has(String(paralegalId))) {
        return;
      }
      const starred =
        !!attorneyKey &&
        Array.isArray(applicant?.starredBy) &&
        applicant.starredBy.some(value => id(value) === attorneyKey);
      entries.push({
        id: `case:${caseId}:${paralegalId || "unknown"}`,
        status: "submitted",
        jobId: id(job?._id) || null,
        jobTitle,
        practiceArea,
        budget,
        caseId,
        paralegal: presentProfilePerson(paralegal),
        coverLetter: applicant?.note || applicant?.coverLetter || "",
        starred,
        createdAt: applicant?.appliedAt || fallbackDate,
      });
    });
  });

  return entries;
}

async function ownSource(req) {
    const blocked = new Set((await getBlockedUserIds(req.user._id || req.user.id)).map(id));
    const stored = await raw(Application, { paralegalId: { $in: refs(req.user._id) } });
    applicationIdentity(stored);
    const jobs = await byIds(Job, stored.map(application => application.jobId));
    const attorneys = await byIds(User, [...jobs.values()].map(job => job.attorneyId), 'firstName lastName name');
    const apps = stored.map(application => {
      const job = jobs.get(id(application.jobId));
      return { ...application, jobId: job ? { ...job, attorneyId: personReference(job.attorneyId, attorneys) } : null };
    });
    const visible = apps.map((app) => ({ ...app, jobId: app.jobId || {
      title: app.scopeSnapshot?.title || "Matter no longer available", status: "closed",
      caseId: app.scopeSnapshot?.caseId || null,
    } }));
    const caseIds = visible
      .map((app) => app?.jobId?.caseId)
      .filter((value) => mongoose.isValidObjectId(value));
    const earlierCases = await raw(Case, { applicants: { $elemMatch: { paralegalId: { $in: refs(req.user._id) } } } }, matterFields);
    const combinedCaseIds = [...caseIds, ...earlierCases.map(doc => doc._id)];
    const casesById = await byIds(Case, combinedCaseIds, matterFields);
    const caseDocs = [...casesById.values()];
    for (const matter of caseDocs) ownerOf(matter);
    for (const job of jobs.values()) validateLink(job, casesById.get(id(job.caseId)));
    const earlierJobs = earlierCases.length ? await raw(Job, { $or: [{ _id: { $in: earlierCases.flatMap(doc => refs(doc.jobId || doc.job)) } }, { caseId: { $in: earlierCases.flatMap(doc => refs(doc._id)) } }] }) : [];
    const earlierJobById = new Map(earlierJobs.map(job => [id(job._id), job]));
    const earlierJobsByCase = new Map(earlierCases.map(doc => { earlierRecords(doc); return [id(doc._id), linkedPosting(doc, earlierJobById)]; }));
    const invitedAttorneys = await byIds(User, earlierCases.map(ownerOf), 'firstName lastName name');
    for (const matter of earlierCases) {
      matter.attorney = personReference(matter.attorney, invitedAttorneys);
      matter.attorneyId = personReference(matter.attorneyId, invitedAttorneys);
    }
    const viewerId = id(req.user._id);
    const payload = visible.map((app) => {
      const job = app.jobId && typeof app.jobId === "object" ? app.jobId : null;
      const caseId = job?.caseId ? id(job.caseId) : "";
      const caseDoc = caseId ? casesById.get(caseId) : null;
      const pre = caseDoc?.preEngagement || null;
      const attorneyName =
        job?.attorneyId?.name ||
        [job?.attorneyId?.firstName, job?.attorneyId?.lastName].filter(Boolean).join(" ").trim() ||
        "";
      const matchesRequestedParalegal =
        !!pre?.requestedParalegalId &&
        id(pre.requestedParalegalId) === viewerId &&
        ["requested", "submitted", "changes_requested"].includes(String(pre.status || "").toLowerCase());
      return {
        ...app,
        profileSnapshot: {
          ...(app.profileSnapshot || {}),
          profileImage: app.profileSnapshot?.profileImage
            ? buildAuthenticatedProfilePhotoUrl(viewerId)
            : "",
        },
        caseId: caseId || null,
        casePaymentReleased: caseDoc?.paymentReleased === true,
        caseEscrowStatus: caseDoc?.escrowStatus || null,
        preEngagement: matchesRequestedParalegal
          ? {
              revision: Math.max(0, Number(pre.revision || 0)),
              status: String(pre.status || "requested").toLowerCase(),
              requestedParalegalId: id(pre.requestedParalegalId),
              confidentialityAgreementRequired: !!pre.confidentialityAgreementRequired,
              conflictsCheckRequired: !!pre.conflictsCheckRequired,
              conflictsDetails: pre.conflictsDetails || "",
              confidentialityDocument: pre.confidentialityDocument || null,
              paralegalConfidentialityDocument: pre.paralegalConfidentialityDocument || null,
              requestedAt: pre.requestedAt || null,
              requestedBy: id(pre.requestedBy) || null,
              requestedByName: attorneyName || null,
              confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
              confidentialityAcknowledgedAt: pre.confidentialityAcknowledgedAt || null,
              conflictsResponseType: pre.conflictsResponseType || "",
              conflictsDisclosureText: pre.conflictsDisclosureText || "",
              submittedAt: pre.submittedAt || null,
              submittedBy: id(pre.submittedBy) || null,
              reviewedAt: pre.reviewedAt || null,
              reviewedBy: id(pre.reviewedBy) || null,
            }
          : null,
      };
    });
    const visibleCaseIdSet = new Set(
      visible
        .map((app) => {
          const job = app?.jobId && typeof app.jobId === "object" ? app.jobId : null;
          return id(job?.caseId);
        })
        .filter(Boolean)
    );
    const earlierEntries = earlierCases
      .map((caseDoc) => {
        const caseId = id(caseDoc?._id);
        if (!caseId || visibleCaseIdSet.has(caseId)) return null;
        const linkedJob = earlierJobsByCase.get(caseId);
        const applicantEntry = Array.isArray(caseDoc?.applicants)
          ? caseDoc.applicants.find((entry) => id(entry?.paralegalId) === viewerId)
          : null;
        if (!applicantEntry) return null;
        const relatedInvite = Array.isArray(caseDoc?.invites)
          ? caseDoc.invites.find(
              (invite) =>
                normalizeInviteParalegalId(invite?.paralegalId) === viewerId &&
                normalizeInviteStatus(invite?.status) === "accepted"
            )
          : null;
        const pre = caseDocs.length ? casesById.get(caseId)?.preEngagement || caseDoc?.preEngagement || null : caseDoc?.preEngagement || null;
        const attorneyName =
          caseDoc?.attorney?.name ||
          caseDoc?.attorneyId?.name ||
          [caseDoc?.attorney?.firstName, caseDoc?.attorney?.lastName].filter(Boolean).join(" ").trim() ||
          [caseDoc?.attorneyId?.firstName, caseDoc?.attorneyId?.lastName].filter(Boolean).join(" ").trim() ||
          "";
        const matchesRequestedParalegal =
          !!pre?.requestedParalegalId &&
          id(pre.requestedParalegalId) === viewerId &&
          ["requested", "submitted", "changes_requested"].includes(String(pre.status || "").toLowerCase());
        const amountCents = Number.isFinite(caseDoc?.lockedTotalAmount) ? caseDoc.lockedTotalAmount : caseDoc?.totalAmount;
        const budget = typeof amountCents === "number" ? amountCents / 100 : null;
        const embeddedStatus = String(applicantEntry?.status || "unknown").toLowerCase();
        return {
          id: "",
          _id: "",
          // Embedded Case applicants retain the legacy `pending` value for
          // compatibility. Expose the canonical Application state so the same
          // user action does not render as Pending or Submitted based only on
          // whether the Matter has a Job mirror.
          status: embeddedStatus === "pending" ? "submitted" : embeddedStatus,
          createdAt: applicantEntry?.appliedAt || relatedInvite?.respondedAt || relatedInvite?.invitedAt || caseDoc?.createdAt || null,
          updatedAt: caseDoc?.updatedAt || null,
          coverLetter: applicantEntry?.note || (relatedInvite ? "Accepted invitation" : ""),
          resumeURL: applicantEntry?.resumeURL || "",
          linkedInURL: applicantEntry?.linkedInURL || "",
          profileSnapshot: {
            ...(applicantEntry?.profileSnapshot || {}),
            profileImage: applicantEntry?.profileSnapshot?.profileImage ? buildAuthenticatedProfilePhotoUrl(viewerId) : "",
          },
          withdrawnAt: applicantEntry?.withdrawnAt || null,
          statusHistory: Array.isArray(applicantEntry?.statusHistory) ? applicantEntry.statusHistory.slice(-50) : [],
          caseId,
          casePaymentReleased: caseDoc?.paymentReleased === true,
          caseEscrowStatus: caseDoc?.escrowStatus || null,
          applicationSource: relatedInvite ? "invite_accept" : "case_applicant",
          ...(!relatedInvite ? { withdrawal: require('./earlierApplicationWithdrawal').presentWithdrawal(caseDoc, linkedJob, applicantEntry) } : {}),
          jobId: {
            _id: id(linkedJob?._id || caseDoc.jobId || caseDoc.job) || caseId,
            id: id(linkedJob?._id || caseDoc.jobId || caseDoc.job) || caseId,
            caseId,
            title: caseDoc?.title || "Untitled Matter",
            practiceArea: caseDoc?.practiceArea || "",
            description: caseDoc?.details || caseDoc?.briefSummary || "",
            budget,
            status: linkedJob?.status || (caseDoc.jobId || caseDoc.job ? "closed" : caseDoc.status),
            attorneyId: caseDoc?.attorneyId || caseDoc?.attorney || null,
          },
          preEngagement: matchesRequestedParalegal
            ? {
                revision: Math.max(0, Number(pre.revision || 0)),
                status: String(pre.status || "requested").toLowerCase(),
                requestedParalegalId: id(pre.requestedParalegalId),
                confidentialityAgreementRequired: !!pre.confidentialityAgreementRequired,
                conflictsCheckRequired: !!pre.conflictsCheckRequired,
                conflictsDetails: pre.conflictsDetails || "",
                confidentialityDocument: pre.confidentialityDocument || null,
                paralegalConfidentialityDocument: pre.paralegalConfidentialityDocument || null,
                requestedAt: pre.requestedAt || null,
                requestedBy: id(pre.requestedBy) || null,
                requestedByName: attorneyName || null,
                confidentialityAcknowledged: !!pre.confidentialityAcknowledged,
                confidentialityAcknowledgedAt: pre.confidentialityAcknowledgedAt || null,
                conflictsResponseType: pre.conflictsResponseType || "",
                conflictsDisclosureText: pre.conflictsDisclosureText || "",
                submittedAt: pre.submittedAt || null,
                submittedBy: id(pre.submittedBy) || null,
                reviewedAt: pre.reviewedAt || null,
                reviewedBy: id(pre.reviewedBy) || null,
              }
            : null,
        };
      })
      .filter(Boolean);
    return [...payload, ...earlierEntries].map(application => {
      const job = application.jobId;
      const matter = casesById.get(id(application.caseId));
      const attorneyId = id(job?.attorneyId);
      const pending = PENDING_STATUSES.has(status(application.status)) && openPosting(job, matter) && !blocked.has(attorneyId);
      return {
        ...application,
        ...(application._id ? { _id: id(application._id) } : {}),
        ...(application.paralegalId ? { paralegalId: id(application.paralegalId) } : {}),
        jobId: { ...job, ...(job?._id ? { _id: id(job._id) } : {}), ...(job?.id ? { id: id(job.id) } : {}), ...(job?.caseId ? { caseId: id(job.caseId) } : {}) },
        pending, caseStatus: matter?.status || null, caseArchived: matter?.archived === true,
        caseAssignedParalegalId: id(matter?.paralegalId || matter?.paralegal) || null,
        preEngagement: pending ? application.preEngagement : null,
      };
    });
}

async function receivedSource(req) {
    const jobs = await raw(Job, { attorneyId: { $in: refs(req.user._id) } }, 'attorneyId title practiceArea budget caseId status');
    const blockedIds = await getBlockedUserIds(req.user._id || req.user.id);
    const blockedSet = new Set(blockedIds.map(id));
    const jobById = new Map(jobs.map(job => [id(job._id), job]));
    const matterById = await byIds(Case, jobs.map(job => job.caseId), matterFields);
    for (const job of jobs) validateLink(job, matterById.get(id(job.caseId)));
    const caseApps = await getCaseApplicationsForAttorney(req.user._id, blockedSet, jobById);
    if (!jobs.length && !caseApps.length) return [];
    const stored = jobs.length ? await raw(Application, { jobId: { $in: jobs.flatMap(job => refs(job._id)) } }) : [];
    applicationIdentity(stored);
    const people = await byIds(User, stored.map(application => application.paralegalId), personFields);
    const apps = stored.filter(application => !blockedSet.has(id(application.paralegalId))).map(application => ({ ...application, paralegalId: safePerson(personReference(application.paralegalId, people)) }));
    const shaped = apps.filter(app => {
      const job = jobById.get(id(app.jobId));
      return PENDING_STATUSES.has(status(app.status)) && openPosting(job, matterById.get(id(job?.caseId)));
    }).map((app) => {
      const job = jobById.get(id(app.jobId)) || {};
      const starred =
        Array.isArray(app.starredBy) &&
        app.starredBy.some(value => id(value) === id(req.user._id || req.user.id));
      return {
        id: id(app._id),
        status: app.status,
        jobId: id(app.jobId) || null,
        jobTitle: job.title || "Untitled Matter",
        practiceArea: job.practiceArea || "",
        budget: Number.isFinite(job.budget) ? job.budget : null,
        caseId: id(job.caseId) || null,
        paralegal: presentProfilePerson(app.paralegalId),
        coverLetter: app.coverLetter || "",
        starred,
        createdAt: app.createdAt,
      };
    });
    const applicationKey = (entry) => {
      const paralegal = entry?.paralegal || {};
      const paralegalId = id(paralegal?._id || paralegal?.id || entry?.paralegalId);
      const contextId = id(entry?.caseId || entry?.jobId);
      return contextId && paralegalId ? `${contextId}:${paralegalId}` : String(entry?.id || "");
    };
    const canonicalKeys = new Set(
      apps.map((app) => {
        const job = jobById.get(id(app.jobId)) || {};
        const paralegal = app?.paralegalId || {};
        const paralegalId = id(paralegal?._id || paralegal?.id || app?.paralegalId);
        const contextId = id(job.caseId || app.jobId);
        return contextId && paralegalId ? `${contextId}:${paralegalId}` : "";
      }).filter(Boolean)
    );
    const combinedByKey = new Map(
      caseApps
        .filter((entry) => !canonicalKeys.has(applicationKey(entry)))
        .map((entry) => [applicationKey(entry), entry])
    );
    shaped.forEach((entry) => combinedByKey.set(applicationKey(entry), entry));
    const combined = [...combinedByKey.values()].sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime || String(a.id).localeCompare(String(b.id));
    });
    return combined;
}

// Read twice without mutation. A changed source is unavailable, not an empty
// queue or a mixture of counts from different revisions.
async function read(req, role, source) {
  await assertAccount(req, role);
  const rows = await source(req);
  const revision = fingerprint(rows);
  const current = await source(req);
  await assertAccount(req, role);
  if (fingerprint(current) !== revision) fail(409, 'APPLICATION_SOURCE_CHANGED', 'Applications changed while loading. Refresh to review the current records.');
  return { rows, revision };
}
module.exports = { readOwn: req => read(req, 'paralegal', ownSource), readReceived: req => read(req, 'attorney', receivedSource), isPending, assertAccount, openMatter, openPosting, PENDING_STATUSES };
