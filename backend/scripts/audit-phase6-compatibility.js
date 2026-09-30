#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const path = require("path");
const { MongoClient } = require("mongodb");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CONFIRMATION = "--confirm-read-only-production-audit";
const FORBIDDEN_ARGUMENT = /(?:apply|write|update|delete|insert|migrate|backfill|stripe)/i;
// Exact identities used by repository E2E scripts or development-only bypass
// allowlists. These values classify provenance; they are never emitted.
const KNOWN_TEST_EMAILS = [
  "samanthasider+0@gmail.com",
  "samanthasider+11@gmail.com",
  "samanthasider+56@gmail.com",
  "samanthasider+attorney@gmail.com",
  "samanthasider+cattorney@gmail.com",
  "samanthasider+paralegal@gmail.com",
  "game4funwithme1@gmail.com",
  "game4funwithme1+1@gmail.com",
  "attorney@example.com",
  "paralegal@example.com",
  "attorney+payout@gmail.com",
  "paralegal+payout@gmail.com",
];
const EXPLICIT_TEST_DOMAIN = /(?:@lets-paraconnect\.(?:dev|local)|@[^@]+\.(?:test|invalid))$/i;

function abort(message) {
  process.stderr.write(`Phase 6 audit refused: ${message}\n`);
  process.exit(2);
}

if (!process.argv.includes(CONFIRMATION)) abort(`missing ${CONFIRMATION}`);
const unsafe = process.argv.slice(2).find((arg) => arg !== CONFIRMATION && FORBIDDEN_ARGUMENT.test(arg));
if (unsafe) abort(`unsupported mutation-related argument ${JSON.stringify(unsafe)}`);
if (!process.env.MONGO_URI) abort("MONGO_URI is not configured");

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

async function aggregate(collection, pipeline) {
  return collection.aggregate(pipeline, { allowDiskUse: false, maxTimeMS: 30_000 }).toArray();
}

async function grouped(collection, field) {
  return aggregate(collection, [
    { $group: { _id: { $ifNull: [`$${field}`, "<missing>"] }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).then((rows) => Object.fromEntries(rows.map((row) => [String(row._id), row.count])));
}

async function count(collection, query = {}) {
  return collection.countDocuments(query, { maxTimeMS: 30_000 });
}

async function main() {
  const parsed = new URL(process.env.MONGO_URI);
  const client = new MongoClient(process.env.MONGO_URI, {
    appName: "lpc-phase6-readonly-audit",
    retryWrites: false,
    readPreference: "primaryPreferred",
    readConcern: { level: "majority" },
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });

  await client.connect();
  const db = client.db();
  const [hello, collections] = await Promise.all([
    db.command({ hello: 1 }),
    db.listCollections({}, { nameOnly: true }).toArray(),
  ]);
  const names = new Set(collections.map((entry) => entry.name));
  const required = ["jobs", "cases", "applications", "users"];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) abort(`required collections are missing: ${missing.join(", ")}`);

  const jobs = db.collection("jobs");
  const cases = db.collection("cases");
  const applications = db.collection("applications");
  const users = db.collection("users");

  const testUsers = await aggregate(users, [
    {
      $match: {
        $or: [
          { email: { $in: KNOWN_TEST_EMAILS } },
          { email: { $regex: EXPLICIT_TEST_DOMAIN } },
        ],
      },
    },
    { $project: { _id: 1 } },
  ]);
  const testUserIds = testUsers.map((entry) => entry._id);

  const [
    jobTotal,
    caseTotal,
    applicationTotal,
    userTotal,
    jobStatuses,
    caseStatuses,
    applicationStatuses,
    applicationSyncStatuses,
    themes,
  ] = await Promise.all([
    count(jobs), count(cases), count(applications), count(users),
    grouped(jobs, "status"), grouped(cases, "status"), grouped(applications, "status"),
    grouped(applications, "syncStatus"), grouped(users, "preferences.theme"),
  ]);

  const [jobCaseLink] = await aggregate(jobs, [
    { $lookup: { from: "cases", localField: "caseId", foreignField: "_id", as: "linked" } },
    { $group: {
      _id: null,
      withCaseId: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$caseId", null] }, null] }, 1, 0] } },
      withoutCaseId: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$caseId", null] }, null] }, 1, 0] } },
      orphanedCaseId: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$caseId", null] }, null] }, { $eq: [{ $size: "$linked" }, 0] }] }, 1, 0] } },
      caseBacklinkMismatch: { $sum: { $cond: [{ $and: [{ $eq: [{ $size: "$linked" }, 1] }, { $ne: [{ $arrayElemAt: ["$linked.jobId", 0] }, "$_id"] }] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const [caseJobLink] = await aggregate(cases, [
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "linked" } },
    { $group: {
      _id: null,
      withJobId: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$jobId", null] }, null] }, 1, 0] } },
      withoutJobId: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$jobId", null] }, null] }, 1, 0] } },
      orphanedJobId: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$jobId", null] }, null] }, { $eq: [{ $size: "$linked" }, 0] }] }, 1, 0] } },
      jobBacklinkMismatch: { $sum: { $cond: [{ $and: [{ $eq: [{ $size: "$linked" }, 1] }, { $ne: [{ $arrayElemAt: ["$linked.caseId", 0] }, "$_id"] }] }, 1, 0] } },
      archived: { $sum: { $cond: ["$archived", 1, 0] } },
      readOnly: { $sum: { $cond: ["$readOnly", 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const [applicationLinks] = await aggregate(applications, [
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
    { $set: { caseId: { $arrayElemAt: ["$job.caseId", 0] } } },
    { $lookup: { from: "cases", localField: "caseId", foreignField: "_id", as: "case" } },
    { $set: {
      mirror: {
        $first: {
          $filter: {
            input: { $ifNull: [{ $arrayElemAt: ["$case.applicants", 0] }, []] },
            as: "candidate",
            cond: { $eq: ["$$candidate.paralegalId", "$paralegalId"] },
          },
        },
      },
    } },
    { $set: { expectedMirrorStatus: { $cond: [{ $eq: ["$status", "submitted"] }, "pending", "$status"] } } },
    { $group: {
      _id: null,
      orphanedJob: { $sum: { $cond: [{ $eq: [{ $size: "$job" }, 0] }, 1, 0] } },
      linkedJobWithoutCase: { $sum: { $cond: [{ $and: [{ $eq: [{ $size: "$job" }, 1] }, { $eq: [{ $ifNull: ["$caseId", null] }, null] }] }, 1, 0] } },
      linkedCaseMissing: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$caseId", null] }, null] }, { $eq: [{ $size: "$case" }, 0] }] }, 1, 0] } },
      activeMirrorMissing: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["submitted", "viewed", "shortlisted"]] }, { $eq: [{ $ifNull: ["$mirror", null] }, null] }] }, 1, 0] } },
      terminalMirrorPresent: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["accepted", "rejected", "withdrawn"]] }, { $ne: [{ $ifNull: ["$mirror", null] }, null] }] }, 1, 0] } },
      withdrawnMirrorPresent: { $sum: { $cond: [{ $and: [{ $eq: ["$status", "withdrawn"] }, { $ne: [{ $ifNull: ["$mirror", null] }, null] }] }, 1, 0] } },
      mirrorStatusMismatch: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$mirror", null] }, null] }, { $ne: ["$mirror.status", "$expectedMirrorStatus"] }] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const applicationLinkByStatus = await aggregate(applications, [
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
    { $set: { caseId: { $arrayElemAt: ["$job.caseId", 0] } } },
    { $lookup: { from: "cases", localField: "caseId", foreignField: "_id", as: "case" } },
    { $set: {
      mirror: {
        $first: {
          $filter: {
            input: { $ifNull: [{ $arrayElemAt: ["$case.applicants", 0] }, []] },
            as: "candidate",
            cond: { $eq: ["$$candidate.paralegalId", "$paralegalId"] },
          },
        },
      },
    } },
    { $group: {
      _id: "$status",
      total: { $sum: 1 },
      orphanedJob: { $sum: { $cond: [{ $eq: [{ $size: "$job" }, 0] }, 1, 0] } },
      mirrorPresent: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$mirror", null] }, null] }, 1, 0] } },
      mirrorMissing: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$mirror", null] }, null] }, 1, 0] } },
    } },
    { $sort: { _id: 1 } },
  ]);

  const [embeddedMirrors] = await aggregate(cases, [
    { $unwind: "$applicants" },
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
    { $set: { resolvedJobId: { $arrayElemAt: ["$job._id", 0] } } },
    { $lookup: {
      from: "applications",
      let: { jobId: "$resolvedJobId", paralegalId: "$applicants.paralegalId" },
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$jobId", "$$jobId"] }, { $eq: ["$paralegalId", "$$paralegalId"] }] } } }],
      as: "canonical",
    } },
    { $group: {
      _id: null,
      total: { $sum: 1 },
      withoutLinkedJob: { $sum: { $cond: [{ $eq: [{ $size: "$job" }, 0] }, 1, 0] } },
      withoutCanonicalApplication: { $sum: { $cond: [{ $eq: [{ $size: "$canonical" }, 0] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const [jobCounts] = await aggregate(jobs, [
    { $lookup: {
      from: "applications",
      let: { job: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$jobId", "$$job"] }, status: { $nin: ["accepted", "rejected", "withdrawn"] } } },
        { $count: "count" },
      ],
      as: "active",
    } },
    { $set: { actual: { $ifNull: [{ $arrayElemAt: ["$active.count", 0] }, 0] } } },
    { $group: {
      _id: null,
      mismatchedApplicantsCount: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$applicantsCount", 0] }, "$actual"] }, 1, 0] } },
      mismatchedOpenApplicantsCount: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["open", "in_review"]] }, { $ne: [{ $ifNull: ["$applicantsCount", 0] }, "$actual"] }] }, 1, 0] } },
      mismatchedClosedApplicantsCount: { $sum: { $cond: [{ $and: [{ $not: [{ $in: ["$status", ["open", "in_review"]] }] }, { $ne: [{ $ifNull: ["$applicantsCount", 0] }, "$actual"] }] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const [legacyCaseFields] = await aggregate(cases, [
    { $group: {
      _id: null,
      attorneyAliasMissing: { $sum: { $cond: [{ $or: [{ $eq: [{ $ifNull: ["$attorney", null] }, null] }, { $eq: [{ $ifNull: ["$attorneyId", null] }, null] }] }, 1, 0] } },
      attorneyAliasMismatch: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$attorney", null] }, null] }, { $ne: [{ $ifNull: ["$attorneyId", null] }, null] }, { $ne: ["$attorney", "$attorneyId"] }] }, 1, 0] } },
      paralegalAliasMismatch: { $sum: { $cond: [{ $ne: [{ $ifNull: ["$paralegal", null] }, { $ifNull: ["$paralegalId", null] }] }, 1, 0] } },
      stateAliasMismatch: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$state", ""] }, ""] }, { $ne: [{ $ifNull: ["$locationState", ""] }, ""] }, { $ne: ["$state", "$locationState"] }] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const [legacyUserFields] = await aggregate(users, [
    { $group: {
      _id: null,
      avatarOnly: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$avatarURL", ""] }, ""] }, { $eq: [{ $ifNull: ["$profileImage", ""] }, ""] }] }, 1, 0] } },
      profileImageOnly: { $sum: { $cond: [{ $and: [{ $eq: [{ $ifNull: ["$avatarURL", ""] }, ""] }, { $ne: [{ $ifNull: ["$profileImage", ""] }, ""] }] }, 1, 0] } },
      bothImageAliases: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$avatarURL", ""] }, ""] }, { $ne: [{ $ifNull: ["$profileImage", ""] }, ""] }] }, 1, 0] } },
      practiceAreasPresent: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$practiceAreas", []] } }, 0] }, 1, 0] } },
      stateExperiencePresent: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$stateExperience", []] } }, 0] }, 1, 0] } },
    } },
    { $project: { _id: 0 } },
  ]);

  const recordProvenance = {
    users: {
      knownTest: testUserIds.length,
      knownReal: 0,
      unknown: userTotal - testUserIds.length,
      realClassificationBasis: "No machine-readable real-customer marker exists; non-test accounts remain unknown.",
    },
    jobs: {
      knownTest: await count(jobs, { attorneyId: { $in: testUserIds } }),
      knownReal: 0,
    },
    cases: {
      knownTest: await count(cases, { $or: [{ attorney: { $in: testUserIds } }, { attorneyId: { $in: testUserIds } }] }),
      knownReal: 0,
    },
  };
  recordProvenance.jobs.unknown = jobTotal - recordProvenance.jobs.knownTest;
  recordProvenance.cases.unknown = caseTotal - recordProvenance.cases.knownTest;

  const applicationProvenanceRows = await aggregate(applications, [
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
    {
      $set: {
        knownTest: {
          $or: [
            { $in: ["$paralegalId", testUserIds] },
            { $in: [{ $arrayElemAt: ["$job.attorneyId", 0] }, testUserIds] },
          ],
        },
      },
    },
    { $group: { _id: "$knownTest", count: { $sum: 1 } } },
  ]);
  const knownTestApplications = Number(applicationProvenanceRows.find((row) => row._id === true)?.count || 0);
  recordProvenance.applications = {
    knownTest: knownTestApplications,
    knownReal: 0,
    unknown: applicationTotal - knownTestApplications,
  };

  const themeByProvenanceRows = await aggregate(users, [
    {
      $set: {
        provenance: { $cond: [{ $in: ["$_id", testUserIds] }, "known_test", "unknown"] },
        themeValue: { $ifNull: ["$preferences.theme", "<missing>"] },
      },
    },
    { $group: { _id: { provenance: "$provenance", theme: "$themeValue" }, count: { $sum: 1 } } },
    { $sort: { "_id.provenance": 1, "_id.theme": 1 } },
  ]);
  const themesByProvenance = { knownTest: {}, knownReal: {}, unknown: {} };
  themeByProvenanceRows.forEach((row) => {
    const bucket = row._id.provenance === "known_test" ? "knownTest" : "unknown";
    themesByProvenance[bucket][String(row._id.theme)] = row.count;
  });

  const issueProvenanceRows = await aggregate(applications, [
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
    { $set: { caseId: { $arrayElemAt: ["$job.caseId", 0] } } },
    { $lookup: { from: "cases", localField: "caseId", foreignField: "_id", as: "case" } },
    {
      $set: {
        provenance: {
          $cond: [
            {
              $or: [
                { $in: ["$paralegalId", testUserIds] },
                { $in: [{ $arrayElemAt: ["$job.attorneyId", 0] }, testUserIds] },
              ],
            },
            "known_test",
            "unknown",
          ],
        },
        mirror: {
          $first: {
            $filter: {
              input: { $ifNull: [{ $arrayElemAt: ["$case.applicants", 0] }, []] },
              as: "candidate",
              cond: { $eq: ["$$candidate.paralegalId", "$paralegalId"] },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: "$provenance",
        total: { $sum: 1 },
        orphanedJob: { $sum: { $cond: [{ $eq: [{ $size: "$job" }, 0] }, 1, 0] } },
        activeMirrorMissing: { $sum: { $cond: [{ $and: [{ $in: ["$status", ["submitted", "viewed", "shortlisted"]] }, { $eq: [{ $ifNull: ["$mirror", null] }, null] }] }, 1, 0] } },
      },
    },
  ]);
  const applicationIssuesByProvenance = { knownTest: { total: 0, orphanedJob: 0, activeMirrorMissing: 0 }, knownReal: { total: 0, orphanedJob: 0, activeMirrorMissing: 0 }, unknown: { total: 0, orphanedJob: 0, activeMirrorMissing: 0 } };
  issueProvenanceRows.forEach((row) => {
    const bucket = row._id === "known_test" ? "knownTest" : "unknown";
    applicationIssuesByProvenance[bucket] = { total: row.total, orphanedJob: row.orphanedJob, activeMirrorMissing: row.activeMirrorMissing };
  });

  const embeddedIssueRows = await aggregate(cases, [
    { $unwind: "$applicants" },
    { $lookup: { from: "jobs", localField: "jobId", foreignField: "_id", as: "job" } },
    { $set: { resolvedJobId: { $arrayElemAt: ["$job._id", 0] }, provenance: { $cond: [{ $or: [{ $in: ["$attorney", testUserIds] }, { $in: ["$attorneyId", testUserIds] }] }, "known_test", "unknown"] } } },
    { $lookup: {
      from: "applications",
      let: { jobId: "$resolvedJobId", paralegalId: "$applicants.paralegalId" },
      pipeline: [{ $match: { $expr: { $and: [{ $eq: ["$jobId", "$$jobId"] }, { $eq: ["$paralegalId", "$$paralegalId"] }] } } }],
      as: "canonical",
    } },
    { $match: { $expr: { $eq: [{ $size: "$canonical" }, 0] } } },
    { $group: { _id: "$provenance", count: { $sum: 1 } } },
  ]);
  const embeddedIssuesByProvenance = { knownTest: 0, knownReal: 0, unknown: 0 };
  embeddedIssueRows.forEach((row) => {
    embeddedIssuesByProvenance[row._id === "known_test" ? "knownTest" : "unknown"] = row.count;
  });

  const userAliasRows = await aggregate(users, [
    { $set: { provenance: { $cond: [{ $in: ["$_id", testUserIds] }, "known_test", "unknown"] } } },
    { $group: {
      _id: "$provenance",
      total: { $sum: 1 },
      bothImageAliases: { $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: ["$avatarURL", ""] }, ""] }, { $ne: [{ $ifNull: ["$profileImage", ""] }, ""] }] }, 1, 0] } },
      practiceAreasPresent: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$practiceAreas", []] } }, 0] }, 1, 0] } },
      stateExperiencePresent: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ["$stateExperience", []] } }, 0] }, 1, 0] } },
    } },
  ]);
  const userAliasesByProvenance = { knownTest: { total: 0, bothImageAliases: 0, practiceAreasPresent: 0, stateExperiencePresent: 0 }, knownReal: { total: 0, bothImageAliases: 0, practiceAreasPresent: 0, stateExperiencePresent: 0 }, unknown: { total: 0, bothImageAliases: 0, practiceAreasPresent: 0, stateExperiencePresent: 0 } };
  userAliasRows.forEach((row) => {
    const bucket = row._id === "known_test" ? "knownTest" : "unknown";
    userAliasesByProvenance[bucket] = { total: row.total, bothImageAliases: row.bothImageAliases, practiceAreasPresent: row.practiceAreasPresent, stateExperiencePresent: row.stateExperiencePresent };
  });

  const jobCountIssuesByProvenanceRows = await aggregate(jobs, [
    { $lookup: {
      from: "applications",
      let: { job: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$jobId", "$$job"] }, status: { $nin: ["accepted", "rejected", "withdrawn"] } } },
        { $count: "count" },
      ],
      as: "active",
    } },
    { $set: { actual: { $ifNull: [{ $arrayElemAt: ["$active.count", 0] }, 0] }, provenance: { $cond: [{ $in: ["$attorneyId", testUserIds] }, "known_test", "unknown"] } } },
    { $match: { $expr: { $ne: [{ $ifNull: ["$applicantsCount", 0] }, "$actual"] } } },
    { $group: { _id: "$provenance", total: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", ["open", "in_review"]] }, 1, 0] } } } },
  ]);
  const jobCountIssuesByProvenance = { knownTest: { total: 0, open: 0 }, knownReal: { total: 0, open: 0 }, unknown: { total: 0, open: 0 } };
  jobCountIssuesByProvenanceRows.forEach((row) => {
    const bucket = row._id === "known_test" ? "knownTest" : "unknown";
    jobCountIssuesByProvenance[bucket] = { total: row.total, open: row.open };
  });

  const report = {
    audit: {
      mode: "read_only_aggregate",
      generatedAt: new Date().toISOString(),
      databaseFingerprint: fingerprint(`${parsed.hostname}/${db.databaseName}`),
      topology: hello.setName ? "replica_set" : "standalone_or_router",
      stripeAccessed: false,
      writesAttempted: 0,
    },
    totals: { jobs: jobTotal, cases: caseTotal, applications: applicationTotal, users: userTotal },
    statuses: { jobs: jobStatuses, cases: caseStatuses, applications: applicationStatuses, applicationSync: applicationSyncStatuses },
    links: { jobsToCases: jobCaseLink || {}, casesToJobs: caseJobLink || {} },
    applicationMirrors: {
      summary: applicationLinks || {},
      byStatus: Object.fromEntries(applicationLinkByStatus.map((row) => [String(row._id), { total: row.total, orphanedJob: row.orphanedJob, mirrorPresent: row.mirrorPresent, mirrorMissing: row.mirrorMissing }])),
      embedded: embeddedMirrors || { total: 0, withoutLinkedJob: 0, withoutCanonicalApplication: 0 },
    },
    derivedCounts: jobCounts || {},
    legacyFields: { cases: legacyCaseFields || {}, users: legacyUserFields || {} },
    storedThemes: themes,
    provenance: {
      classificationEvidence: {
        exactRepositoryFixtureIdentities: KNOWN_TEST_EMAILS.length,
        reservedHarnessDomains: ["lets-paraconnect.dev", "lets-paraconnect.local", ".test", ".invalid"],
        shapeBasedInferenceUsed: false,
      },
      records: recordProvenance,
      themes: themesByProvenance,
      applicationIssues: applicationIssuesByProvenance,
      embeddedApplicationIssues: embeddedIssuesByProvenance,
      jobCountIssues: jobCountIssuesByProvenance,
      userAliases: userAliasesByProvenance,
    },
    redirects: {
      databaseUsageAvailable: false,
      determination: "Retain until access-log or analytics usage is separately measured.",
    },
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  await client.close();
}

main().catch((error) => {
  const safe = String(error?.message || error || "unknown error")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "<mongodb-uri-redacted>")
    .slice(0, 1000);
  process.stderr.write(`Phase 6 audit failed: ${safe}\n`);
  process.exit(1);
});
