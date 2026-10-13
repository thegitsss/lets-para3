const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });

const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { revokeAllUserSessions } = require("../services/authSessionService");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");
const { validateNewPassword } = require("../utils/passwordPolicy");

function adminSeedConfiguration(env = process.env) {
  const mongoUri = requireMongoUri(env.MONGO_URI);
  const email = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  const confirmationEmail = String(env.SEED_ADMIN_CONFIRM_EMAIL || "").trim().toLowerCase();
  const password = String(env.ADMIN_PASSWORD || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set ADMIN_EMAIL to the exact admin email address.");
  }
  if (confirmationEmail !== email) {
    throw new Error("SEED_ADMIN_CONFIRM_EMAIL must exactly match ADMIN_EMAIL.");
  }
  const passwordPolicy = validateNewPassword(password, {
    user: { email, firstName: "Admin", lastName: "User" },
  });
  if (!passwordPolicy.ok) throw new Error(passwordPolicy.error);

  return { mongoUri, email, password: passwordPolicy.password };
}

async function seedAdmin({ env = process.env } = {}) {
  const config = adminSeedConfiguration(env);
  try {
    await mongoose.connect(config.mongoUri, MONGO_OPERATION_OPTIONS);

    let admin = await User.findOne({ email: config.email }).select("+password +authVersion");
    const created = !admin;
    if (!admin) {
      admin = new User({ email: config.email });
    }

    const roleChanged = admin.role !== "admin";
    const passwordChanged = created ? true : !(await admin.comparePassword(config.password));
    admin.firstName = "Admin";
    admin.lastName = "User";
    admin.role = "admin";
    admin.status = "approved";
    admin.emailVerified = true;
    if (!admin.approvedAt) {
      admin.approvedAt = new Date();
    }
    if (passwordChanged) {
      admin.password = config.password;
      if (!created) admin.authVersion = Number(admin.authVersion || 0) + 1;
    }

    await admin.save();
    if (!created && (passwordChanged || roleChanged)) {
      await revokeAllUserSessions(admin._id, "privileged_seed_change");
    }
    await AuditLog.create({
      actorRole: "system",
      action: "admin.seed",
      targetType: "user",
      targetId: String(admin._id),
      meta: { created, roleChanged, passwordChanged },
    });
    console.log(JSON.stringify({ ok: true, email: config.email, created, roleChanged, passwordChanged }));
    return { admin, created, roleChanged, passwordChanged };
  } catch (err) {
    console.error("Failed to seed admin:", err?.message || err);
    throw err;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

if (require.main === module) {
  seedAdmin().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  adminSeedConfiguration,
  seedAdmin,
};
