// Private single-primary fixture cleanup: wait for the real shutdown before
// memory-server can send SIGINT or start its ten-second kill watchdog.
const { MongoClient } = require("mongoose").mongo;
const { observeProcessExit } = require("./globalMongoTeardown");

module.exports = async function stopOwnedReplicaSet(replica) {
  if (!replica) return;
  const servers = replica.servers;
  if (!Array.isArray(servers) || servers.length !== 1) throw new Error("Fixture cleanup requires its owned single-primary replica.");
  const server = servers[0], instance = server.instanceInfo?.instance;
  const uri = replica.getUri();
  const address = new URL(uri);
  if (address.hostname !== "127.0.0.1" || Number(address.port) !== server.instanceInfo?.port) throw new Error("Fixture cleanup requires its exact owned loopback Mongo port.");
  const child = instance?.mongodProcess;
  const terminal = observeProcessExit(child).then(exit => ({ exit }), error => ({ error }));
  const errors = [];
  const client = new MongoClient(uri, { directConnection: true, maxPoolSize: 1, connectTimeoutMS: 10000, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 15000 });
  try {
    await client.connect();
    await client.db("admin").command({ shutdown: 1, force: true, timeoutSecs: 1 });
  } catch (error) {
    // The command closes its own socket; only the actual normal child exit
    // below establishes success. Other errors remain visible failures.
    if (error.name !== "MongoNetworkError" && error.code !== 11600) errors.push(error);
  } finally { await client.close().catch(error => errors.push(error)); }
  const result = await terminal;
  if (result.exit?.code === 0 && result.exit.signal === null) instance.mongodProcess = undefined;
  else errors.push(result.error || new Error(`Owned replica exited abnormally: ${JSON.stringify(result.exit)}`));
  await replica.stop({ doCleanup: true, force: true }).catch(error => errors.push(error));
  if (errors.length) throw new AggregateError(errors, "The owned fixture replica did not shut down normally.");
};
