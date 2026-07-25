"use strict";

// Fiche "Récupérables" — appartient à PROBAR ou PROMESH, identifiée par
// (module, machine, poste, date) : une seule fiche possible par
// combinaison (contrainte unique ci-dessous). Reste ouverte 6 jours à
// partir de sa date de création (createdAt), puis passe automatiquement à
// "cloturee" (recalculé côté service, jamais confiance aveugle dans la
// colonne `statut`).
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes("recuperable_fiches")) return;

    await queryInterface.createTable("recuperable_fiches", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      module: { type: Sequelize.ENUM("PROBAR", "PROMESH"), allowNull: false },
      machine: { type: Sequelize.STRING(50), allowNull: false },
      poste: { type: Sequelize.ENUM("matin", "soir"), allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },

      statut: {
        type: Sequelize.ENUM("en_cours", "cloturee"),
        allowNull: false,
        defaultValue: "en_cours",
      },
      dateCloture: { type: Sequelize.DATEONLY, allowNull: false },

      createdBy: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // Une seule fiche par Module + Machine + Poste + Date.
    await queryInterface.addIndex("recuperable_fiches", ["module", "machine", "poste", "date"], {
      unique: true,
      name: "recuperable_fiches_module_machine_poste_date_unique",
    });
    await queryInterface.addIndex("recuperable_fiches", ["statut"]);
    await queryInterface.addIndex("recuperable_fiches", ["createdBy"]);
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes("recuperable_fiches")) return;
    await queryInterface.dropTable("recuperable_fiches");
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_fiches_module";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_fiches_poste";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_recuperable_fiches_statut";');
  },
};
