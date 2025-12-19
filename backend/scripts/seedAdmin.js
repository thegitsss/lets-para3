const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const User = require("../models/User");

const raw = process.env.MONGO_URI || "";
const MONGO = /<cluster>/.test(raw) || !raw ? "mongodb://127.0.0.1:27017/lets-para" : raw;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@lets-paraconnect.com").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin123!";

async function seedAdmin() {
  try {
    await mongoose.connect(MONGO);

    let admin = await User.findOne({ email: ADMIN_EMAIL });
    if (!admin) {
      admin = new User({ email: ADMIN_EMAIL });
    }

    admin.firstName = "Admin";
    admin.lastName = "User";
    admin.role = "admin";
    admin.status = "approved";
    admin.approved = true;
    if (!admin.approvedAt) {
      admin.approvedAt = new Date();
    }
    admin.password = ADMIN_PASSWORD;

    await admin.save();
    console.log(`✅ Admin ready (${ADMIN_EMAIL}).`);
  } catch (err) {
    console.error("❌ Failed to seed admin:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

seedAdmin();
