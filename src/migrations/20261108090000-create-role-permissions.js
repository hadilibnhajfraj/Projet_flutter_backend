"use strict";

// Permissions nommées accordées PAR RÔLE, enregistrées en base (lues par
// src/config/rolePermissions.js). Purement additif : aucune table existante,
// aucun compte ni aucun rôle n'est modifié.
//   role_permissions(role, permission) — unique par couple.
// Attribution initiale, idempotente (ON CONFLICT DO NOTHING) :
//   backoffice_readonly → production.read_all (consultation globale du module
//   Production, GET uniquement — aucune écriture).
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        "role_permissions",
        {
          id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true },
          role: { type: Sequelize.STRING(64), allowNull: false },
          permission: { type: Sequelize.STRING(100), allowNull: false },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("NOW()") },
        },
        { transaction: t }
      );
      await queryInterface.addIndex("role_permissions", ["role", "permission"], { unique: true, name: "role_permissions_role_permission_uq", transaction: t });
      await queryInterface.sequelize.query(
        `INSERT INTO role_permissions (role, permission) VALUES ('backoffice_readonly', 'production.read_all')
         ON CONFLICT (role, permission) DO NOTHING`,
        { transaction: t }
      );
      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable("role_permissions");
  },
};
