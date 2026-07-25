"use strict";

// mfaLastSentAt : horodatage du dernier EMAIL OTP réellement mis en file
// d'envoi (distinct de mfaLastVerifiedAt, qui suit la validation du code,
// pas son envoi) — sert de cooldown anti-spam SMTP (60s minimum entre deux
// envois, voir services/mfa.service.js).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "mfaLastSentAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "mfaLastSentAt");
  },
};
