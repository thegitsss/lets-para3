const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const User = require("../models/User");

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required");
  }

  await mongoose.connect(process.env.MONGO_URI);

  const users = await User.find({
    status: "approved",
    emailVerified: false,
  }).select("_id approvedAt emailVerified");

  let updated = 0;

  for (const user of users) {
    user.emailVerified = true;
    if (!user.approvedAt) user.approvedAt = new Date();
    await user.save();
    updated += 1;
  }

  console.log(JSON.stringify({ scanned: users.length, updated }, null, 2));
  await mongoose.connection.close();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
