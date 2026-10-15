// A separate application process sharing only the disposable test database.
// Real route authorization and writers run here; external mail is captured.
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const mail = [];
const emailPath = require.resolve('../../utils/email');
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: async (...args) => { mail.push(args); return { ok: true }; } };

(async () => {
  const input = JSON.parse(process.argv[2]);
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(input.uri) || input.dbName !== 'jest' || process.env.NODE_ENV !== 'test') throw Error('Disposable loopback Jest database required');
  const app = express();
  app.use(require('cookie-parser')(), express.json());
  app.use('/api/messages', require('../../routes/messages'));
  app.use('/api/notifications', require('../../routes/notifications'));
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  await mongoose.connect(input.uri, { dbName: input.dbName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  try {
    if (!['get', 'post', 'delete'].includes(input.method) || !/^\/api\/(messages|notifications)\//.test(input.path)) throw Error('Unsupported test request');
    let pending = request(app)[input.method](input.path).set('Cookie', input.cookie);
    if (input.body) pending = pending.send(input.body);
    const response = await pending;
    process.stdout.write('\nLPC_INSTANCE_RESULT:' + JSON.stringify({ status: response.status, body: response.body, mailCount: mail.length }) + '\n');
  } finally { await mongoose.disconnect(); }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
