const fs = require("fs");
const path = require("path");
const jestConfig = require("../jest.config");
const {
  STATE_PATH,
  isProcessAlive,
  readReadyState,
} = require("./helpers/mongoHarnessState");
const { testDatabaseName } = require("./helpers/db");

describe("shared Jest Mongo harness", () => {
  test("every model collection and declared index is ready before a suite connects", async () => {
    const mongoose = require('mongoose'), modelsDirectory = path.resolve(__dirname, '../models');
    for (const file of fs.readdirSync(modelsDirectory).filter(name => name.endsWith('.js')).sort()) require(path.join(modelsDirectory, file));
    const client = new mongoose.mongo.MongoClient(readReadyState().uri);
    await client.connect();
    try {
      const db = client.db(testDatabaseName), names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name));
      for (const model of Object.values(mongoose.models)) {
        expect(names.has(model.collection.name)).toBe(true);
        const indexes = (await db.collection(model.collection.name).listIndexes().toArray()).map(index => index.name);
        const expected = model.schema.indexes().map(([fields, options]) => options.name || (Object.keys(fields).length === 1 && fields._id === 1 ? '_id_' : Object.entries(fields).map(([key, direction]) => `${key}_${direction}`).join('_')));
        expect(indexes).toEqual(expect.arrayContaining([...new Set(['_id_', ...expected])]));
      }
    } finally { await client.close(); }
  });

  test("enforces global lifecycle and serial database isolation", () => {
    expect(jestConfig.globalSetup).toBe("<rootDir>/tests/helpers/globalMongoSetup.js");
    expect(jestConfig.globalTeardown).toBe("<rootDir>/tests/helpers/globalMongoTeardown.js");
    expect(jestConfig.maxWorkers).toBe(1);
    expect(testDatabaseName).toBe("jest");
    const teardownSource = fs.readFileSync(
      path.resolve(__dirname, "helpers/globalMongoTeardown.js"),
      "utf8"
    );
    expect(teardownSource).toMatch(/client\.db\("jest"\)\.dropDatabase/);
    expect(teardownSource).toMatch(/\.command\(\{ shutdown: 1, force: true, timeoutSecs: 1 \}\)/);
    expect(teardownSource).toMatch(/observeProcessExit/);
    expect(teardownSource).toMatch(/mongoInstance\.mongodProcess = undefined/);
    expect(teardownSource).toMatch(/processOwner\.stop\(\{ doCleanup: true, force: true \}\)/);
    expect(teardownSource).toMatch(/new AggregateError/);
  });

  test("publishes owner-only, live, loopback state", () => {
    const state = readReadyState();
    const stat = fs.lstatSync(STATE_PATH);

    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
    expect(state.status).toBe("ready");
    expect(state.uri).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/);
    expect(isProcessAlive(state.ownerPid)).toBe(true);
  });
});

const { EventEmitter } = require('events');
const { observeProcessExit } = require('./helpers/globalMongoTeardown');
test('Mongo shutdown observer handles normal, already-exited, and timed-out children', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const pending = observeProcessExit(child, 1000);
  child.emit('exit', 0, null);
  await expect(pending).resolves.toEqual({ code: 0, signal: null });
  expect(child.listenerCount('exit')).toBe(0);
  child.exitCode = 0;
  await expect(observeProcessExit(child)).resolves.toEqual({ code: 0, signal: null });
  child.exitCode = null;
  await expect(observeProcessExit(child, 5)).rejects.toThrow(/did not exit/);
  expect(child.listenerCount('exit')).toBe(0);
});

test("the shared loopback database commits and rolls back real Matter-style transactions", async () => {
  const { MongoClient } = require("mongoose").mongo, client = new MongoClient(readReadyState().uri), requestId = require("crypto").randomUUID();
  await client.connect(); const db = client.db("jest"), collection = db.collection("harness_transaction_probe"), session = client.startSession();
  try {
    expect((await db.admin().command({ hello: 1 })).setName).toBeTruthy();
    await db.createCollection("harness_transaction_probe").catch(error => { if (error.code !== 48) throw error; });
    session.startTransaction(); await collection.insertOne({ _id: requestId, state: "recorded" }, { session }); await session.commitTransaction(); expect((await collection.findOne({ _id: requestId })).state).toBe("recorded");
    session.startTransaction(); await collection.updateOne({ _id: requestId }, { $set: { state: "uncommitted" } }, { session }); await session.abortTransaction(); expect((await collection.findOne({ _id: requestId })).state).toBe("recorded");
  } finally { if (session.inTransaction()) await session.abortTransaction(); await collection.deleteOne({ _id: requestId }); await session.endSession(); await client.close(); }
});
