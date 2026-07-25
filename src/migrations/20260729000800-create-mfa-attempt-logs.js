"use strict";

// Journal des tentatives MFA (date, ip, email, succès/échec) — même pattern
// que password_reset_logs (services/passwordResetLog.service.js).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("mfa_attempt_logs", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "users", key: "id" },
        onDelete: "SET NULL",
      },
      email: { type: Sequelize.STRING(200), allowNull: false },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      action: {
        type: Sequelize.ENUM(
          "otp_requested",
          "otp_verified",
          "otp_failed",
          "device_trusted",
          "device_rejected",
          "mfa_invalidated"
        ),
        allowNull: false,
      },
      success: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reason: { type: Sequelize.STRING(64), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("mfa_attempt_logs", ["email", "createdAt"]);
    await queryInterface.addIndex("mfa_attempt_logs", ["userId", "createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("mfa_attempt_logs");
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_mfa_attempt_logs_action"`);
  },
};
