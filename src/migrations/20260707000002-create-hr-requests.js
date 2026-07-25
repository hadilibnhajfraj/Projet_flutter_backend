"use strict";

// Table unique partagée par les deux types de demande RH (congé /
// autorisation de sortie) — même approche que `industrial_records` (une
// table générique plutôt qu'une table par sous-type). Les champs employé
// sont dupliqués au moment de la création (snapshot) pour que la demande
// reste fidèle même si le profil RH change plus tard.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("hr_requests", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      type: { type: Sequelize.ENUM("conge", "sortie"), allowNull: false },
      statut: {
        type: Sequelize.ENUM("en_attente", "acceptee", "refusee"),
        allowNull: false,
        defaultValue: "en_attente",
      },

      requestedBy: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },

      // Snapshot employé (jamais saisi par l'utilisateur — copié depuis UserProfile)
      employeeNom: { type: Sequelize.STRING(120), allowNull: true },
      employeePrenom: { type: Sequelize.STRING(120), allowNull: true },
      employeeMatricule: { type: Sequelize.STRING(50), allowNull: true },
      employeeQualification: { type: Sequelize.STRING(150), allowNull: true },
      employeeDepartement: { type: Sequelize.STRING(150), allowNull: true },
      employeeService: { type: Sequelize.STRING(150), allowNull: true },
      employeeEmail: { type: Sequelize.STRING(200), allowNull: true },

      // Demande de congé
      typeConge: { type: Sequelize.ENUM("ordinaire", "maladie"), allowNull: true },
      dateDebut: { type: Sequelize.DATEONLY, allowNull: true },
      dateFin: { type: Sequelize.DATEONLY, allowNull: true },
      nombreJours: { type: Sequelize.INTEGER, allowNull: true },
      anneeConge: { type: Sequelize.INTEGER, allowNull: true },
      adresse: { type: Sequelize.STRING(255), allowNull: true },
      telephone: { type: Sequelize.STRING(50), allowNull: true },

      // Autorisation de sortie
      motif: { type: Sequelize.STRING(255), allowNull: true },
      dateSortie: { type: Sequelize.DATEONLY, allowNull: true },
      heureSortie: { type: Sequelize.STRING(5), allowNull: true },
      heureRetour: { type: Sequelize.STRING(5), allowNull: true },

      commentaire: { type: Sequelize.TEXT, allowNull: true },
      signature: { type: Sequelize.STRING(200), allowNull: true },

      emailSentAt: { type: Sequelize.DATE, allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("hr_requests", ["type"]);
    await queryInterface.addIndex("hr_requests", ["statut"]);
    await queryInterface.addIndex("hr_requests", ["requestedBy"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("hr_requests");
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_hr_requests_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_hr_requests_statut";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_hr_requests_typeConge";');
  },
};
