"use strict";

// Champs MFA sur users :
//   - mfaLastVerifiedAt : dernière fois où l'utilisateur a validé un OTP MFA
//     (gouverne la règle "3 jours" / "24h admin", voir mfa.service.js).
//   - lastLoginIp/Browser/Country/DeviceId : contexte de la DERNIÈRE connexion
//     réussie (post-MFA le cas échéant) — comparé à chaque nouvelle connexion
//     pour détecter IP/navigateur/appareil/pays différents (force un MFA
//     immédiat même sur un appareil de confiance, voir cahier des charges).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "mfaLastVerifiedAt", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "lastLoginIp", {
      type: Sequelize.STRING(64),
      allowNull: true,
    });
    await queryInterface.addColumn("users", "lastLoginBrowser", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
    await queryInterface.addColumn("users", "lastLoginCountry", {
      type: Sequelize.STRING(2),
      allowNull: true,
    });
    await queryInterface.addColumn("users", "lastLoginDeviceId", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("users", "mfaLastVerifiedAt");
    await queryInterface.removeColumn("users", "lastLoginIp");
    await queryInterface.removeColumn("users", "lastLoginBrowser");
    await queryInterface.removeColumn("users", "lastLoginCountry");
    await queryInterface.removeColumn("users", "lastLoginDeviceId");
  },
};
