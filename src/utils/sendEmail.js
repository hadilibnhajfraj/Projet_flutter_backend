// utils/sendEmail.js

const nodemailer = require("nodemailer");

// =========================
// 🔥 CONFIG SMTP
// =========================
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
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
// 🚀 TEMPLATE RELANCE INGENIEUR
// =========================
async function sendRelanceIngenieurEmail(userEmail, project) {
  return sendEmail({
    to: userEmail,
    subject: "⚠️ Projet incomplet - Ingénieur manquant",
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
// 🚀 TEMPLATE RELANCE ENTREPRISE
// =========================
async function sendRelanceEntrepriseEmail(userEmail, project) {
  return sendEmail({
    to: userEmail,
    subject: "⚠️ Projet incomplet - Entreprise manquante",
    html: `
      <div style="font-family: Arial; padding:20px;">
        <h2 style="color:#f0ad4e;">⚠️ Entreprise manquante</h2>
        
        <p>Le projet <strong>${project.nomProjet}</strong> ne contient pas d’entreprise.</p>

        <p>Veuillez compléter les informations dans un délai de <strong>7 jours</strong>.</p>

        <hr/>

        <p style="color:#777;">
          CRM PROBAR - Suivi automatique
        </p>
      </div>
    `,
  });
}
// =========================
// 🚀 TEMPLATE RELANCE BUREAU CONTROLE
// =========================
async function sendRelanceBureauControleEmail(userEmail, project) {
  return sendEmail({
    to: userEmail,
    subject: "⚠️ Projet incomplet - Bureau de contrôle manquant",
    html: `
      <div style="font-family: Arial; padding:20px;">
        <h2 style="color:#5bc0de;">⚠️ Bureau de contrôle manquant</h2>
        
        <p>Le projet <strong>${project.nomProjet}</strong> ne contient pas de bureau de contrôle.</p>

        <p>Merci de compléter ces informations dès que possible.</p>

        <hr/>

        <p style="color:#777;">
          CRM PROBAR - Notification automatique
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
  sendRelanceEntrepriseEmail,
  sendRelanceBureauControleEmail,
};