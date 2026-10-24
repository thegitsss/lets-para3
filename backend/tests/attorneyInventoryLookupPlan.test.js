const { Types } = require('mongoose');
const { connect, clearDatabase, closeDatabase } = require('./helpers/db');
const Case = require('../models/Case');
const Job = require('../models/Job');
const Application = require('../models/Application');
const { inventoryPipeline, parseInventoryQuery, readInventory } = require('../services/attorneyMatterInventory');

beforeAll(connect); beforeEach(clearDatabase); afterAll(closeDatabase);
const id = () => new Types.ObjectId();
const representation = (value, index) => [value, String(value), String(value).toUpperCase()][index % 3];
const filters = parseInventoryQuery({ view: 'applications', sort: 'alphabetical' });
const aggregate = owner => Case.aggregate(inventoryPipeline(String(owner), filters)).collation({ locale: 'en', strength: 3 });
const joins = explain => explain.stages.filter(stage => ['jobs', 'applications'].includes(stage.$lookup?.from));

async function insertPopulation(owner, count) {
  const cases = [], jobs = [], applications = [];
  for (let index = 0; index < count; index++) {
    const caseId = id(), jobId = id(), applicationId = id(), personId = id();
    cases.push({ _id: caseId, attorney: representation(owner, index), attorneyId: owner, title: `Owned ${String(index).padStart(3, '0')}`, status: 'open', applicants: [], ...(index % 4 ? { jobId: representation(jobId, index + 1) } : {}) });
    jobs.push({ _id: representation(jobId, index), caseId: representation(caseId, index + 2), attorneyId: representation(owner, index + 1), status: 'open', description: 'Private Job details must not enter inventory metadata.' });
    applications.push({ _id: representation(applicationId, index + 2), jobId: representation(jobId, index + 2), paralegalId: personId, status: ['submitted', 'viewed', 'shortlisted'][index % 3], coverLetter: 'Private application text must not enter inventory metadata.' });
  }
  await Case.collection.insertMany(cases);
  await Job.collection.insertMany(jobs);
  await Application.collection.insertMany(applications);
  return cases;
}

test('mixed legacy references remain owner scoped and paged without scanning other owners applications', async () => {
  const owner = id(), other = id();
  const owned = await insertPopulation(owner, 40);
  await insertPopulation(other, 400);
  const [result] = await aggregate(owner);
  expect(result.invalid).toEqual([]);
  expect(result.counts).toEqual([{ _id: 'applications', count: 40 }]);
  expect(result.total).toEqual([{ count: 40 }]);
  expect(result.rows.map(row => String(row._id))).toEqual(owned.slice(0, 15).map(row => String(row._id)));
  expect(JSON.stringify(result)).not.toContain('Private');
  const read = await readInventory(String(owner), filters);
  expect(read).toMatchObject({ total: 40, pages: 3, counts: { active: 0, applications: 40, draft: 0, archived: 0 } });
  await expect(read.verify()).resolves.toBeUndefined();
  const plan = joins(await aggregate(owner).explain('executionStats'));
  expect(plan).toHaveLength(3);
  for (const stage of plan) {
    expect(stage.collectionScans).toBe(0);
    expect(stage.totalDocsExamined).toBeLessThanOrEqual(40 * 8);
  }
});

test('ambiguous legacy reverse links stop after two matches and cannot return a Matter list', async () => {
  const owner = id(), caseId = id();
  await Case.collection.insertOne({ _id: caseId, attorney: owner, attorneyId: owner, title: 'Ambiguous private Matter', status: 'open', applicants: [] });
  await Job.collection.insertMany(Array.from({ length: 240 }, () => ({ _id: id(), caseId: String(caseId), attorneyId: owner, status: 'open' })));
  const [result] = await aggregate(owner);
  expect(result.invalid).toEqual([{ _id: caseId }]);
  await expect(readInventory(String(owner), filters)).rejects.toMatchObject({ status: 409 });
  const reverse = joins(await aggregate(owner).explain('executionStats')).find(stage => stage.$lookup.foreignField === 'caseId');
  expect(reverse).toBeDefined();
  expect(reverse.collectionScans).toBe(0);
  expect(reverse.totalDocsExamined).toBe(2);
});
