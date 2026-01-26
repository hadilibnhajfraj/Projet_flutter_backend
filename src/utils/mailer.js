// utils/mailer.js
const nodemailer = require("nodemailer");

function getTransporter() {
  const host = process.env.EMAIL_HOST;
  const port = Number(process.env.EMAIL_PORT || 587);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const secure = String(process.env.EMAIL_SECURE || "false") === "true";

  return nodemailer.createTransport({
    host,
    port,
    secure, // false pour 587, true pour 465
    auth: { user, pass },
  });
}

async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  return transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendMail };
