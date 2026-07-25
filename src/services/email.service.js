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

// Vérifie la connexion/authentification SMTP une fois au démarrage — permet
// de détecter immédiatement un identifiant invalide (EAUTH/535) au lieu de
// le découvrir seulement au premier envoi réel, potentiellement des heures
// plus tard (voir point 6 de la demande).
transporter.verify((err) => {
  if (err) {
    console.error("❌ [SMTP verify] ÉCHEC — vérifiez EMAIL_HOST/EMAIL_PORT/EMAIL_USER/EMAIL_PASS dans .env :", err.message);
  } else {
    console.log(`✅ [SMTP verify] OK — ${process.env.EMAIL_HOST}:${process.env.EMAIL_PORT} (user=${process.env.EMAIL_USER})`);
  }
});

const sendEmail = async (to, subject, text, meta = {}, options = {}) => {
  const timestamp = dayjs().format("YYYY-MM-DD HH:mm:ss");

  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
      // html : corps enrichi optionnel (ex. bouton "Consulter la demande").
      // attachments : pièces jointes nodemailer (ex. [{ filename, content: Buffer }]).
      ...(options.html ? { html: options.html } : {}),
      ...(options.attachments?.length ? { attachments: options.attachments } : {}),
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