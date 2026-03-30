// utils/sendEmail.js

const nodemailer = require("nodemailer");

// =========================
// 🔥 CONFIG SMTP
// =========================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false, // true si 465
  auth: {
    user: process.env.SMTP_USER, // ex: ton email
    pass: process.env.SMTP_PASS, // mot de passe ou app password
  },
});

// =========================
// ✅ FONCTION PRINCIPALE
// =========================
async function sendEmail({ to, subject, text, html }) {
  try {
    if (!to) throw new Error("Email destinataire manquant");

    const mailOptions = {
      from: `"CRM PROBAR" <${process.env.SMTP_USER}>`,
      to,
      subject: subject || "Notification CRM",
      text: text || "",
      html: html || null,
    };

    const info = await transporter.sendMail(mailOptions);

    console.log("📧 Email envoyé:", info.messageId);

    return true;
  } catch (error) {
    console.error("❌ EMAIL ERROR:", error.message);
    return false;
  }
}

// =========================
// 🚀 TEMPLATE RELANCE CRM
// =========================
async function sendRelanceIngenieurEmail(userEmail, project) {
  return sendEmail({
    to: userEmail,
    subject: "⚠️ Projet incomplet - Action requise",
    html: `
      <div style="font-family: Arial; padding:20px;">
        <h2 style="color:#d9534f;">⚠️ Action requise</h2>
        
        <p>Le projet <strong>${project.nomProjet}</strong> n'a pas encore d'ingénieur assigné.</p>

        <p>Veuillez ajouter les informations de l’ingénieur dans un délai de <strong>7 jours</strong>.</p>

        <hr/>

        <p style="color:#777;">
          ⚠️ Après ce délai, le projet sera automatiquement archivé.
        </p>
      </div>
    `,
  });
}

// =========================
// EXPORTS
// =========================
module.exports = {
  sendEmail,
  sendRelanceIngenieurEmail,
};