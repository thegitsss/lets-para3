const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST, // e.g., smtp.zoho.com
  port: process.env.SMTP_PORT, // 465 (SSL) or 587 (TLS)
  secure: process.env.SMTP_PORT == 465, // true for 465, false for 587
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmail(to, subject, html) {
  const mailOptions = {
    from: `"ParaConnect" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html: `<div style="font-family: Georgia, serif; font-size: 16px; color: #5c4e3a;">${html}</div>`
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error(`❌ Failed to send email to ${to}`, err);
  }
}

module.exports = sendEmail;
