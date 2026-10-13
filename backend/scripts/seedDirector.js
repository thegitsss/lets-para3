const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });

const AuditLog = require("../models/AuditLog");
const DirectorProfile = require("../models/DirectorProfile");
const User = require("../models/User");
const { revokeAllUserSessions } = require("../services/authSessionService");
const { validateNewPassword } = require("../utils/passwordPolicy");
const {
  MONGO_OPERATION_OPTIONS,
  requireMongoUri,
} = require("../utils/mongooseOperationPolicy");

const MAX_TEMPLATE_BYTES = 256 * 1024;

function readTemplateHtml(env = process.env) {
  const inlineHtml = String(env.DIRECTOR_OUTREACH_TEMPLATE_HTML || "").trim();
  if (inlineHtml) return inlineHtml;
  const configuredPath = String(env.DIRECTOR_OUTREACH_TEMPLATE_FILE || "").trim();
  if (!configuredPath) return "";

  const filePath = path.resolve(configuredPath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("DIRECTOR_OUTREACH_TEMPLATE_FILE must identify a regular, non-symlink file.");
  }
  if (stat.size > MAX_TEMPLATE_BYTES) {
    throw new Error(`DIRECTOR_OUTREACH_TEMPLATE_FILE must not exceed ${MAX_TEMPLATE_BYTES} bytes.`);
  }
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .replace(/&lt;p&gt;Hi\s+\{\{attorneyName\}\},&lt;\/p&gt;/i, "<p>Hi {{attorneyName}},</p>");
}

function directorSeedConfiguration(env = process.env) {
  const mongoUri = requireMongoUri(env.MONGO_URI);
  const email = String(env.DIRECTOR_EMAIL || "").trim().toLowerCase();
  const confirmationEmail = String(env.SEED_DIRECTOR_CONFIRM_EMAIL || "").trim().toLowerCase();
  const firstName = String(env.DIRECTOR_FIRST_NAME || "Director").trim();
  const lastName = String(env.DIRECTOR_LAST_NAME || "User").trim();
  const activeState = String(env.DIRECTOR_ACTIVE_STATE || "").trim().toUpperCase();
  const passwordPolicy = validateNewPassword(env.DIRECTOR_PASSWORD || "", {
    user: { email, firstName, lastName },
  });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set DIRECTOR_EMAIL to the exact director email address.");
  }
  if (confirmationEmail !== email) {
    throw new Error("SEED_DIRECTOR_CONFIRM_EMAIL must exactly match DIRECTOR_EMAIL.");
  }
  if (!passwordPolicy.ok) throw new Error(passwordPolicy.error);
  if (!/^[A-Z]{2}$/.test(activeState)) {
    throw new Error("DIRECTOR_ACTIVE_STATE must be a two-letter US state abbreviation.");
  }

  return {
    mongoUri,
    email,
    password: passwordPolicy.password,
    firstName,
    lastName,
    activeState,
    outreachSubject: String(
      env.DIRECTOR_OUTREACH_SUBJECT || "for matters that need an extra hand next"
    ).trim(),
    outreachTemplateText: String(env.DIRECTOR_OUTREACH_TEMPLATE_TEXT || "").trim(),
    outreachTemplateHtml: readTemplateHtml(env),
  };
}

async function seedDirector({ env = process.env } = {}) {
  const config = directorSeedConfiguration(env);
  try {
    await mongoose.connect(config.mongoUri, MONGO_OPERATION_OPTIONS);

    let user = await User.findOne({ email: config.email }).select("+password +authVersion");
    const created = !user;
    if (!user) user = new User({ email: config.email });

    const roleChanged = user.role !== "director";
    const passwordChanged = created ? true : !(await user.comparePassword(config.password));
    user.firstName = config.firstName;
    user.lastName = config.lastName;
    user.role = "director";
    user.status = "approved";
    user.emailVerified = true;
    if (!user.approvedAt) user.approvedAt = new Date();
    if (passwordChanged) user.password = config.password;
    if (!created && (passwordChanged || roleChanged)) {
      user.authVersion = Number(user.authVersion || 0) + 1;
    }
    await user.save();

    await DirectorProfile.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          email: config.email,
          zohoEmail: config.email,
          displayName: `${user.firstName} ${user.lastName}`.trim(),
          activeState: config.activeState,
          status: "active",
          outreachSubject: config.outreachSubject,
          ...(config.outreachTemplateText
            ? { outreachTemplateText: config.outreachTemplateText }
            : {}),
          ...(config.outreachTemplateHtml
            ? { outreachTemplateHtml: config.outreachTemplateHtml }
            : {}),
        },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );

    if (!created && (passwordChanged || roleChanged)) {
      await revokeAllUserSessions(user._id, "privileged_seed_change");
    }
    await AuditLog.create({
      actorRole: "system",
      action: "director.seed",
      targetType: "user",
      targetId: String(user._id),
      meta: { created, roleChanged, passwordChanged },
    });
    console.log(JSON.stringify({ ok: true, email: config.email, created, roleChanged, passwordChanged }));
    return { user, created, roleChanged, passwordChanged };
  } catch (err) {
    console.error("Failed to seed director:", err?.message || err);
    throw err;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

if (require.main === module) {
  seedDirector().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_TEMPLATE_BYTES,
  directorSeedConfiguration,
  readTemplateHtml,
  seedDirector,
};
