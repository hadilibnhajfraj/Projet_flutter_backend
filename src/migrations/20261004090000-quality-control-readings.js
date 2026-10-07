"use strict";

// Module CONTRÔLE QUALITÉ — RELEVÉS périodiques : une fiche de contrôle
// qualité porte plusieurs relevés (un par heure de contrôle), chaque relevé
// porte ses paramètres.
//
// - quality_control_readings (nouvelle) : relevé d'une fiche (heure, résultat,
//   validation), unique par (fiche, heure) ;
// - quality_control_items."readingId" : les paramètres existants sont
//   rattachés à un relevé (la table existante EST la table des paramètres
//   d'un relevé — aucune table en double) ; l'unicité passe de
//   (fiche, paramètre) à (relevé, paramètre) ;
// - quality_control_history."readingTime" : heure du relevé concerné.
//
// Données existantes : chaque fiche devient une fiche à UN relevé. Heure du
// relevé = ancien paramètre « HEURE » s'il est renseigné (HH:mm), sinon
// l'heure d'ouverture, sinon l'heure de création (Tunis). Aucune valeur
// supprimée (les anciennes lignes « heure » restent en base).
//
// Retour arrière : refusé s'il existe une fiche à plusieurs relevés (perte
// de données).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });

      await queryInterface.createTable(
        "quality_control_readings",
        {
          id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
          qualityControlId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "quality_controls", key: "id" },
            onDelete: "CASCADE",
          },
          readingTime: { type: Sequelize.TIME, allowNull: false },
          status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "EN_ATTENTE" },
          validatedAt: { type: Sequelize.DATE, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction }
      );

      await q(`
        INSERT INTO quality_control_readings (id, "qualityControlId", "readingTime", status, "validatedAt", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), c.id,
               COALESCE(
                 (SELECT i.value::time FROM quality_control_items i
                   WHERE i."qualityControlId" = c.id AND i."parameterKey" = 'heure'
                     AND i.value ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' LIMIT 1),
                 to_char(c."controlTime", 'HH24:MI')::time,
                 to_char(c."createdAt" AT TIME ZONE 'Africa/Tunis', 'HH24:MI')::time
               ),
               c.status, c."validatedAt", c."createdAt", c."updatedAt"
          FROM quality_controls c
         WHERE EXISTS (SELECT 1 FROM quality_control_items i WHERE i."qualityControlId" = c.id)
      `);

      await queryInterface.addColumn(
        "quality_control_items",
        "readingId",
        { type: Sequelize.UUID, allowNull: true, references: { model: "quality_control_readings", key: "id" }, onDelete: "CASCADE" },
        { transaction }
      );
      await q(`
        UPDATE quality_control_items i SET "readingId" = r.id
          FROM quality_control_readings r WHERE r."qualityControlId" = i."qualityControlId"
      `);
      await q(`ALTER TABLE quality_control_items ALTER COLUMN "readingId" SET NOT NULL`);

      await q(`DROP INDEX IF EXISTS uq_quality_control_items_parameter`);
      await q(`CREATE UNIQUE INDEX uq_quality_control_items_reading_parameter ON quality_control_items ("readingId", "parameterKey")`);
      await q(`CREATE INDEX idx_quality_control_items_control ON quality_control_items ("qualityControlId")`);
      await q(`CREATE UNIQUE INDEX uq_quality_control_readings_time ON quality_control_readings ("qualityControlId", "readingTime")`);

      await queryInterface.addColumn("quality_control_history", "readingTime", { type: Sequelize.STRING(5), allowNull: true }, { transaction });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const [multi] = await q(
        `SELECT "qualityControlId" FROM quality_control_readings GROUP BY 1 HAVING COUNT(*) > 1 LIMIT 1`
      );
      if (multi.length) {
        throw new Error("Retour arrière impossible : des fiches de contrôle qualité portent plusieurs relevés.");
      }
      await queryInterface.removeColumn("quality_control_history", "readingTime", { transaction });
      await q(`DROP INDEX IF EXISTS uq_quality_control_items_reading_parameter`);
      await q(`DROP INDEX IF EXISTS idx_quality_control_items_control`);
      await queryInterface.removeColumn("quality_control_items", "readingId", { transaction });
      await q(`CREATE UNIQUE INDEX uq_quality_control_items_parameter ON quality_control_items ("qualityControlId", "parameterKey")`);
      await queryInterface.dropTable("quality_control_readings", { transaction });
    });
  },
};
