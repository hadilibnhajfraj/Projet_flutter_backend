const cron = require("node-cron");
const dayjs = require("dayjs");
const { Op } = require("sequelize");

const { sendEmail } = require("../services/email.service");

const CommercialContactRelance = require("../models/CommercialContactRelance");
const CommercialContact = require("../models/CommercialContact");

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
      where: {
        dateRelance: today,
      },
    });

    console.log("📊 RELANCES TODAY:", relances.length);

    for (let contact of contacts) {
      try {
        if (!contact.email) {
          console.log(`⚠️ No email: ${contact.nom}`);
          continue;
        }

        const relance = relances.find(
          (r) => r.commercialContactId === contact.id
        );

        // =========================
        // ✅ CAS RELANCE AUJOURD’HUI
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

            relance.emailSent = true;
            await relance.save();
          } else {
            console.log(`❌ EMAIL FAILED: ${contact.nom}`);
          }
        }

        // =========================
        // ❌ PAS DE RELANCE
        // =========================
        else {
          console.log(`⚠️ No follow-up: ${contact.nom}`);

          await sendEmail(
            contact.email,
            "⚠️ Follow-up manquant",
            `Aucun follow-up défini pour ${contact.nom}. Merci de planifier une relance.`
          );
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

// 🔥 PROD (activer après test)
// cron.schedule("0 8 * * *", checkFollowup, {
//   timezone: "Africa/Tunis",
// });

module.exports = { checkFollowup };