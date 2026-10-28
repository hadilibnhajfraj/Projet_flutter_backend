"use strict";

// Traçabilité des demandes de matières premières (menu « Matières premières ») :
//   - numéro unique DMP-AAAA-000001 (séquence PostgreSQL : jamais de doublon,
//     même en cas de créations simultanées) ;
//   - date de production concernée (= jour de la demande, heure de Tunisie) ;
//   - date / auteur de validation ;
//   - historique des changements de statut.
// Les demandes existantes sont conservées : numérotées dans l'ordre de
// création, et leur statut « VALIDATED » (posé par le formulaire, sans aucune
// validation réelle) devient « SUBMITTED », avec une entrée d'historique.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await q(`CREATE SEQUENCE IF NOT EXISTS raw_material_request_number_seq`);

      await queryInterface.addColumn("raw_material_requests", "requestNumber", { type: Sequelize.STRING(30), allowNull: true }, { transaction });
      await queryInterface.addColumn("raw_material_requests", "productionDate", { type: Sequelize.DATEONLY, allowNull: true }, { transaction });
      await queryInterface.addColumn("raw_material_requests", "validatedAt", { type: Sequelize.DATE, allowNull: true }, { transaction });
      await queryInterface.addColumn("raw_material_requests", "validatedBy", { type: Sequelize.UUID, allowNull: true }, { transaction });
      await queryInterface.addColumn("raw_material_requests", "validatedByEmail", { type: Sequelize.STRING(255), allowNull: true }, { transaction });

      // Numérotation des demandes existantes dans l'ordre de création.
      await q(`
        UPDATE raw_material_requests r SET "requestNumber" = n.num
          FROM (
            SELECT id, 'DMP-' || to_char("createdAt" AT TIME ZONE 'Africa/Tunis', 'YYYY') || '-' ||
                   lpad(nextval('raw_material_request_number_seq')::text, 6, '0') AS num
              FROM (SELECT id, "createdAt" FROM raw_material_requests ORDER BY "createdAt", id) o
          ) n
         WHERE r.id = n.id`);
      await q(`UPDATE raw_material_requests SET "productionDate" = "requestDate" WHERE "productionDate" IS NULL`);
      await q(`UPDATE raw_material_requests SET status = 'SUBMITTED' WHERE status = 'VALIDATED'`);

      await queryInterface.changeColumn("raw_material_requests", "requestNumber", { type: Sequelize.STRING(30), allowNull: false }, { transaction });
      await queryInterface.changeColumn("raw_material_requests", "productionDate", { type: Sequelize.DATEONLY, allowNull: false }, { transaction });
      await queryInterface.changeColumn("raw_material_requests", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "SUBMITTED" }, { transaction });
      await queryInterface.addIndex("raw_material_requests", ["requestNumber"], { unique: true, name: "raw_material_requests_request_number_uq", transaction });
      await queryInterface.addIndex("raw_material_requests", ["requestDate"], { transaction });
      await queryInterface.addIndex("raw_material_requests", ["status"], { transaction });

      await queryInterface.createTable(
        "raw_material_request_status_histories",
        {
          id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
          requestId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "raw_material_requests", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
          },
          fromStatus: { type: Sequelize.STRING(20), allowNull: true }, // null : création
          toStatus: { type: Sequelize.STRING(20), allowNull: false },
          changedBy: { type: Sequelize.UUID, allowNull: true },
          changedByEmail: { type: Sequelize.STRING(255), allowNull: true },
          comment: { type: Sequelize.TEXT, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
          updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn("NOW") },
        },
        { transaction }
      );
      await queryInterface.addIndex("raw_material_request_status_histories", ["requestId", "createdAt"], { transaction });

      // Historique des demandes existantes : leur soumission, à leur date réelle.
      await q(`
        INSERT INTO raw_material_request_status_histories
          (id, "requestId", "fromStatus", "toStatus", "changedBy", "changedByEmail", comment, "createdAt", "updatedAt")
        SELECT gen_random_uuid(), id, NULL, 'SUBMITTED', "userId", "userEmail",
               'Historique reconstitué : demande soumise depuis le formulaire', "createdAt", "createdAt"
          FROM raw_material_requests`);
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("raw_material_request_status_histories", { transaction });
      await queryInterface.removeIndex("raw_material_requests", "raw_material_requests_request_number_uq", { transaction });
      await queryInterface.removeIndex("raw_material_requests", ["requestDate"], { transaction });
      await queryInterface.removeIndex("raw_material_requests", ["status"], { transaction });
      await queryInterface.sequelize.query(`UPDATE raw_material_requests SET status = 'VALIDATED' WHERE status = 'SUBMITTED'`, { transaction });
      await queryInterface.changeColumn("raw_material_requests", "status", { type: Sequelize.STRING(20), allowNull: false, defaultValue: "VALIDATED" }, { transaction });
      for (const col of ["validatedByEmail", "validatedBy", "validatedAt", "productionDate", "requestNumber"]) {
        await queryInterface.removeColumn("raw_material_requests", col, { transaction });
      }
      await queryInterface.sequelize.query(`DROP SEQUENCE IF EXISTS raw_material_request_number_seq`, { transaction });
    });
  },
};
