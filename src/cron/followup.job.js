const cron = require("node-cron");
const dayjs = require("dayjs");

const { sendEmail } = require("../services/email.service");

const CommercialContactRelance = require("../models/CommercialContactRelance");
const CommercialContact = require("../models/CommercialContact");
const Notification = require("../models/Notification");

console.log("🔥 FOLLOWUP CRON LOADED");

// =========================
// 🔥 MAIN FUNCTION
// =========================
const checkFollowup = async () => {
  const now = dayjs();
  const today = now.format("YYYY-MM-DD");

  console.log("🚀 CRON START (FOLLOW-UP)");
  console.log("📅 TODAY:", today);

  try {
    // =========================
    // 👥 1. GET ALL CONTACTS
    // =========================
    const contacts = await CommercialContact.findAll();
    console.log("👥 TOTAL CONTACTS:", contacts.length);

    // =========================
    // 📅 2. GET TODAY RELANCES
    // =========================
    const relances = await CommercialContactRelance.findAll({
      where: { dateRelance: today },
    });

    console.log("📊 RELANCES TODAY:", relances.length);

    // 🔥 OPTIMISATION (lookup rapide)
    const relanceMap = new Map();
    relances.forEach((r) => {
      relanceMap.set(r.commercialContactId, r);
    });

    // =========================
    // 🔁 LOOP CONTACTS
    // =========================
    for (let contact of contacts) {
      try {
        if (!contact.email) {
          console.log(`⚠️ No email: ${contact.nom}`);

          await Notification.create({
            userId: contact.createdBy,
            type: "FOLLOWUP_MISSING",
            title: "Email manquant",
            message: `Le contact ${contact.nom} n'a pas d'email`,
            isRead: false,
          });

          continue;
        }

        const relance = relanceMap.get(contact.id);

        // =========================
        // ✅ RELANCE AUJOURD’HUI
        // =========================
        if (relance) {
          if (relance.emailSent) {
            console.log(`⏭️ Already sent: ${contact.nom}`);
            continue;
          }

          console.log(`📅 Relance TODAY: ${contact.nom}`);

          const result = await sendEmail(
            contact.email,
            "🔔 Rappel Follow-up",
            `Relance prévue aujourd’hui pour ${contact.nom} ${contact.prenom}.`
          );

          if (result.success) {
            console.log(`✅ EMAIL SENT: ${contact.nom}`);

            // 🔥 UPDATE RELANCE
            relance.emailSent = true;
            await relance.save();

            // 🔥 NOTIFICATION
            await Notification.create({
              userId: relance.createdBy,
              type: "FOLLOWUP",
              title: "Relance envoyée",
              message: `Email envoyé à ${contact.nom} ${contact.prenom}`,
              isRead: false,
            });
          } else {
            console.log(`❌ EMAIL FAILED: ${contact.nom}`);

            await Notification.create({
              userId: relance.createdBy,
              type: "FOLLOWUP_ERROR",
              title: "Erreur envoi",
              message: `Échec d'envoi pour ${contact.nom}`,
              isRead: false,
            });
          }
        }

        // =========================
        // ❌ PAS DE RELANCE
        // =========================
        else {
          console.log(`⚠️ No follow-up: ${contact.nom}`);

          const result = await sendEmail(
            contact.email,
            "⚠️ Follow-up manquant",
            `Aucun follow-up défini pour ${contact.nom}. Merci de planifier une relance.`
          );

          if (result.success) {
            await Notification.create({
              userId: contact.createdBy,
              type: "FOLLOWUP_MISSING",
              title: "Relance manquante",
              message: `Aucune relance définie pour ${contact.nom}`,
              isRead: false,
            });
          }
        }
      } catch (err) {
        console.error("❌ LOOP ERROR:", err.message);
      }
    }

    console.log("✅ CRON END");
  } catch (err) {
    console.error("❌ CRON ERROR:", err);
  }
};

// =========================
// ⏰ SCHEDULER
// =========================

// 🔥 TEST (chaque minute)
cron.schedule("*/1 * * * *", checkFollowup, {
  timezone: "Africa/Tunis",
});

// 🔥 PROD
// cron.schedule("0 8 * * *", checkFollowup, {
//   timezone: "Africa/Tunis",
// });

module.exports = { checkFollowup };