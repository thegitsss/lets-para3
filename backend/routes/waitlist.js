// backend/routes/waitlist.js
const express = require("express");
const nodemailer = require("nodemailer");
const router = express.Router();

const validEmail = (v) => /.+@.+\..+/.test(v);

function makeTransport() {
  const pool = String(process.env.SMTP_POOL || "false").toLowerCase() === "true";
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true", // 465 => true
    pool,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Zoho is fine without custom tls, but you can uncomment if needed:
    // tls: { minVersion: "TLSv1.2" },
  });
  return transporter;
}

async function sendNotification(email) {
  const transporter = makeTransport();
  const to = process.env.NOTIFY_TO || process.env.SMTP_USER;
  const fromName = process.env.SMTP_FROM_NAME || "ParaConnect";
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

  await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: "New waitlist signup",
    text: `New signup: ${email}`,
    html: `<p>New signup: <b>${email}</b></p>`,
  });
}

router.post("/", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim();
    if (!validEmail(email)) return res.status(400).json({ ok: false, error: "invalid_email" });
    await sendNotification(email);
    return res.json({ ok: true });
  } catch (err) {
    console.error("waitlist error:", err);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
