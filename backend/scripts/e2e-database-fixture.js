const fs = require("node:fs");
const path = require("node:path");

// Match the isolated backend harness: finish collection/index preparation before
// browser or API transactions can run against this disposable database.
async function connectE2eDatabase(mongoose, uri) {
  const automatic = { autoCreate: mongoose.get("autoCreate"), autoIndex: mongoose.get("autoIndex") };
  mongoose.set("autoCreate", false);
  mongoose.set("autoIndex", false);
  const directory = path.resolve(__dirname, "../models");
  // Some transaction services import their notice models only on first use.
  // Prepare those too, as the existing complete-app browser harness does.
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".js")).sort()) {
    require(path.join(directory, name));
  }
  await mongoose.connect(uri, { dbName: "e2e", autoCreate: false, autoIndex: false });
  for (const model of Object.values(mongoose.models)) {
    await model.init();
    await model.createCollection();
    await model.createIndexes();
  }
  mongoose.connection.config.autoCreate = true;
  mongoose.connection.config.autoIndex = true;
  mongoose.set("autoCreate", automatic.autoCreate);
  mongoose.set("autoIndex", automatic.autoIndex);
}

module.exports = { connectE2eDatabase };
