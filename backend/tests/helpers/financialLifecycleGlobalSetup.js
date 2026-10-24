// Reuse the existing private, transactional shared-Mongo lifecycle. All models
// and index constraints are prepared once; workers still clear records and
// recheck their model indexes, and retain every browser/request deadline.
module.exports = async function financialLifecycleGlobalSetup() {
  Object.assign(process.env, {
    NODE_ENV: 'test', DATA_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    EMAIL_DISABLE: 'true', LPC_LIFECYCLE_USE_SHARED_MONGO: 'true',
    LPC_TEST_MONGO_NAMESPACE: `financial-browser-${process.pid}`,
  });
  await require('./globalMongoSetup')();
};
