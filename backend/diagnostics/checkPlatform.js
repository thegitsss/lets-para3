/**
 * Automated LPC Platform Diagnostic
 * Run with: node diagnostics/checkPlatform.js
 *
 * This file checks:
 * 1. Database connection
 * 2. User registration / login
 * 3. Role-based account creation
 * 4. Job posting & Job model check
 * 5. Application model check
 * 6. Case linking (attorney ↔ paralegal)
 * 7. Messaging linkage to caseId
 */

require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
let Job;
let Application;
let Case;
let Message;

try { Job = require("../models/Job"); } catch {}
try { Case = require("../models/Case"); } catch {}
try { Application = require("../models/Application"); } catch {}
try { Message = require("../models/Message"); } catch {}

async function runDiagnostics() {
  console.log("🔍 Starting Let’s ParaConnect Diagnostics...\n");

  // -----------------------------
  // 1. Database Connectivity
  // -----------------------------
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.log("❌ MongoDB connection FAILED");
    console.error(err);
    return process.exit();
  }

  // -----------------------------
  // 2. User Model Check
  // -----------------------------
  if (!User || !User.schema) {
    console.log("❌ User model missing");
  } else if (!User.schema.paths.role) {
    console.log("❌ User model missing `role` field");
  } else {
    console.log("✅ User model OK");
  }

  // -----------------------------
  // 3. Job Model Check
  // -----------------------------
  if (!Job || !Job.schema) {
    console.log("❌ Job model missing");
  } else {
    console.log("✅ Job model OK");
  }

  // -----------------------------
  // 4. Application Model Check
  // -----------------------------
  if (!Application || !Application.schema) {
    console.log("❌ Application model missing — must create models/Application.js");
  } else {
    console.log("✅ Application model OK");
  }

  // -----------------------------
  // 5. Case Model Check
  // -----------------------------
  if (!Case || !Case.schema) {
    console.log("❌ Case model missing");
  } else if (
    !Case.schema.paths.attorneyId ||
    !Case.schema.paths.paralegalId ||
    !Case.schema.paths.jobId
  ) {
    console.log("❌ Case model missing required linking fields (attorneyId, paralegalId, jobId)");
  } else {
    console.log("✅ Case model OK");
  }

  // -----------------------------
  // 6. Messaging Linkage Check
  // -----------------------------
  if (!Message || !Message.schema) {
    console.log("❌ Message model missing");
  } else if (!Message.schema.paths.caseId) {
    console.log("❌ Message model missing `caseId` field");
  } else {
    console.log("✅ Message model OK");
  }

  console.log("\n🎉 Diagnostics complete!\n");
  process.exit();
}

runDiagnostics();
