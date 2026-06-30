const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const DirectorProfile = require("../models/DirectorProfile");
const User = require("../models/User");

const raw = process.env.MONGO_URI || "";
const MONGO = /<cluster>/.test(raw) || !raw ? "mongodb://127.0.0.1:27017/lets-para" : raw;
const DIRECTOR_EMAIL = String(process.env.DIRECTOR_EMAIL || "skyler@lets-paraconnect.com").trim().toLowerCase();
const DIRECTOR_PASSWORD = process.env.DIRECTOR_PASSWORD || "";
const DIRECTOR_FIRST_NAME = String(process.env.DIRECTOR_FIRST_NAME || "Skyler").trim();
const DIRECTOR_LAST_NAME = String(process.env.DIRECTOR_LAST_NAME || "Director").trim();
const DIRECTOR_ACTIVE_STATE = String(process.env.DIRECTOR_ACTIVE_STATE || "TX").trim().toUpperCase();
const DIRECTOR_OUTREACH_SUBJECT = String(
  process.env.DIRECTOR_OUTREACH_SUBJECT || "for matters that need an extra hand next"
).trim();
const DIRECTOR_OUTREACH_TEMPLATE_TEXT = String(process.env.DIRECTOR_OUTREACH_TEMPLATE_TEXT || "").trim();
const DIRECTOR_OUTREACH_TEMPLATE_FILE = String(process.env.DIRECTOR_OUTREACH_TEMPLATE_FILE || "").trim();

function readTemplateHtml() {
  const inlineHtml = String(process.env.DIRECTOR_OUTREACH_TEMPLATE_HTML || "").trim();
  if (inlineHtml) return inlineHtml;
  if (!DIRECTOR_OUTREACH_TEMPLATE_FILE) return "";
  const filePath = path.resolve(DIRECTOR_OUTREACH_TEMPLATE_FILE);
  const html = fs.readFileSync(filePath, "utf8").trim();
  return html.replace(/&lt;p&gt;Hi\s+\{\{attorneyName\}\},&lt;\/p&gt;/i, "<p>Hi {{attorneyName}},</p>");
}

const DIRECTOR_OUTREACH_TEMPLATE_HTML = readTemplateHtml();

async function seedDirector() {
  try {
    await mongoose.connect(MONGO);

    let user = await User.findOne({ email: DIRECTOR_EMAIL }).select("+password");
    if (!user) {
      if (!DIRECTOR_PASSWORD || DIRECTOR_PASSWORD.length < 8) {
        throw new Error("Set DIRECTOR_PASSWORD in backend/.env or the shell before creating a director account.");
      }
      user = new User({ email: DIRECTOR_EMAIL });
    }

    user.firstName = DIRECTOR_FIRST_NAME || "Director";
    user.lastName = DIRECTOR_LAST_NAME || "User";
    user.role = "director";
    user.status = "approved";
    user.emailVerified = true;
    if (!user.approvedAt) user.approvedAt = new Date();
    if (DIRECTOR_PASSWORD) {
      if (DIRECTOR_PASSWORD.length < 8) throw new Error("DIRECTOR_PASSWORD must be at least 8 characters.");
      user.password = DIRECTOR_PASSWORD;
    }

    await user.save();

    await DirectorProfile.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          email: DIRECTOR_EMAIL,
          zohoEmail: DIRECTOR_EMAIL,
          displayName: `${user.firstName} ${user.lastName}`.trim(),
          activeState: DIRECTOR_ACTIVE_STATE || "TX",
          status: "active",
          outreachSubject: DIRECTOR_OUTREACH_SUBJECT,
          ...(DIRECTOR_OUTREACH_TEMPLATE_TEXT ? { outreachTemplateText: DIRECTOR_OUTREACH_TEMPLATE_TEXT } : {}),
          ...(DIRECTOR_OUTREACH_TEMPLATE_HTML ? { outreachTemplateHtml: DIRECTOR_OUTREACH_TEMPLATE_HTML } : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`Director ready (${DIRECTOR_EMAIL}).`);
  } catch (err) {
    console.error("Failed to seed director:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

seedDirector();
