"use strict";

// Module CONTRÔLE QUALITÉ — checklist de production remplie par le rôle
// controle_qualite. Distinct de por_promesh_controles_qualite (tableau de
// mesures maille/longueur/largeur saisi par l'OPÉRATEUR dans la fiche
// PROMESH elle-même), laissé strictement inchangé.
//
// - quality_controls         : un contrôle = une fiche PROMESH/PROBAR contrôlée
//                              (plusieurs contrôles possibles par fiche).
// - quality_control_items    : les 15 paramètres de la checklist (toujours
//                              créés tous les 15 à la création du contrôle).
// - quality_control_history  : journal append-only (ancienne/nouvelle valeur,
//                              utilisateur, horodatage) — jamais mis à jour.
//
// FK vers quality_controls en RESTRICT : un contrôle n'est jamais supprimé
// physiquement (suppression logique via deletedAt), l'historique ne peut donc
// pas disparaître par cascade.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "quality_controls",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          // Fiche contrôlée : por_promesh.id (PROMESH) ou industrial_records.id
          // (PROBAR) — pas de FK SQL possible sur une référence polymorphe,
          // l'existence est vérifiée par le service à la création.
          productionRecordId: { type: Sequelize.UUID, allowNull: false },
          productionType: { type: Sequelize.STRING(10), allowNull: false },
          // Instantané de la fiche au moment du contrôle (numéro lisible,
          // machine, poste, date de production) — jamais saisi par le client.
          ficheNumero: { type: Sequelize.STRING(40), allowNull: true },
          machine: { type: Sequelize.STRING(50), allowNull: true },
          poste: { type: Sequelize.STRING(20), allowNull: true },
          productionDate: { type: Sequelize.DATEONLY, allowNull: true },
          controllerUserId: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
          },
          controllerEmail: { type: Sequelize.STRING(200), allowNull: false },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "EN_ATTENTE" },
          remark: { type: Sequelize.TEXT, allowNull: true },
          // Horodatage serveur posé à la validation (instant UTC) + sa
          // projection en heure de Tunisie (Africa/Tunis).
          checkedAt: { type: Sequelize.DATE, allowNull: true },
          controlDate: { type: Sequelize.DATEONLY, allowNull: true },
          controlTime: { type: Sequelize.TIME, allowNull: true },
          validatedAt: { type: Sequelize.DATE, allowNull: true },
          deletedAt: { type: Sequelize.DATE, allowNull: true },
          deletedBy: { type: Sequelize.UUID, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE quality_controls
           ADD CONSTRAINT chk_quality_controls_status
           CHECK (status IN ('EN_ATTENTE','EN_COURS','CONFORME','NON_CONFORME')),
           ADD CONSTRAINT chk_quality_controls_production_type
           CHECK ("productionType" IN ('PROMESH','PROBAR'))`,
        { transaction }
      );
      await queryInterface.addIndex("quality_controls", ["productionType", "productionRecordId"], {
        name: "idx_quality_controls_production_record",
        transaction,
      });
      await queryInterface.addIndex("quality_controls", ["controllerUserId", "createdAt"], {
        name: "idx_quality_controls_controller_created",
        transaction,
      });
      await queryInterface.addIndex("quality_controls", ["status"], { name: "idx_quality_controls_status", transaction });

      await queryInterface.createTable(
        "quality_control_items",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          qualityControlId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "quality_controls", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "RESTRICT",
          },
          parameterKey: { type: Sequelize.STRING(50), allowNull: false },
          parameterName: { type: Sequelize.STRING(100), allowNull: false },
          position: { type: Sequelize.INTEGER, allowNull: false },
          value: { type: Sequelize.STRING(255), allowNull: true },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "NON_CONTROLE" },
          remark: { type: Sequelize.TEXT, allowNull: true },
          checkedAt: { type: Sequelize.DATE, allowNull: true },
          checkedBy: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
          },
          checkedByEmail: { type: Sequelize.STRING(200), allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE quality_control_items
           ADD CONSTRAINT chk_quality_control_items_status
           CHECK (status IN ('CONFORME','NON_CONFORME','NON_CONTROLE'))`,
        { transaction }
      );
      await queryInterface.addIndex("quality_control_items", ["qualityControlId", "parameterKey"], {
        unique: true,
        name: "uq_quality_control_items_parameter",
        transaction,
      });

      await queryInterface.createTable(
        "quality_control_history",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          qualityControlId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "quality_controls", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "RESTRICT",
          },
          // CREATE | UPDATE | VALIDATE | STATUS_CHANGE | DELETE
          action: { type: Sequelize.STRING(30), allowNull: false },
          parameterKey: { type: Sequelize.STRING(50), allowNull: true },
          // value | status | remark (item) — status | remark (contrôle)
          field: { type: Sequelize.STRING(30), allowNull: true },
          oldValue: { type: Sequelize.TEXT, allowNull: true },
          newValue: { type: Sequelize.TEXT, allowNull: true },
          reason: { type: Sequelize.TEXT, allowNull: true },
          userId: { type: Sequelize.UUID, allowNull: true },
          userEmail: { type: Sequelize.STRING(200), allowNull: true },
          changedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.addIndex("quality_control_history", ["qualityControlId", "changedAt"], {
        name: "idx_quality_control_history_control",
        transaction,
      });

      // Même pattern que maintenanceRequestId / hrRequestId / actionId :
      // lien optionnel d'une notification vers l'objet qui l'a déclenchée.
      await queryInterface.addColumn("notifications", "qualityControlId", { type: Sequelize.UUID, allowNull: true }, { transaction });
      await queryInterface.addIndex("notifications", ["qualityControlId"], { name: "notifications_quality_control_id", transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex("notifications", "notifications_quality_control_id", { transaction });
      await queryInterface.removeColumn("notifications", "qualityControlId", { transaction });
      await queryInterface.dropTable("quality_control_history", { transaction });
      await queryInterface.dropTable("quality_control_items", { transaction });
      await queryInterface.dropTable("quality_controls", { transaction });
    });
  },
};
