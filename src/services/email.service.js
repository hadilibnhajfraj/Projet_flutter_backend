const nodemailer = require("nodemailer");
const dayjs = require("dayjs");

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT),
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false, // ⚠️ dev only
  },
});

const sendEmail = async (to, subject, text, meta = {}) => {
  const timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
    });

    console.log(`
================ EMAIL SUCCESS ================
📧 Date       : ${timestamp}
📨 To         : ${to}
📌 Subject    : ${subject}
🆔 Message ID : ${info.messageId}
📦 Meta       : ${JSON.stringify(meta)}
===============================================
    `);

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`
================ EMAIL ERROR ==================
❌ Date    : ${timestamp}
📨 To      : ${to}
📌 Subject : ${subject}
💥 Error   : ${error.message}
📦 Meta    : ${JSON.stringify(meta)}
===============================================
    `);

    return { success: false, error: error.message };
  }
};

module.exports = { sendEmail };