"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("por_promesh", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
      },

      dateProduction: { type: Sequelize.DATEONLY, allowNull: false },
      heureDebut: { type: Sequelize.TIME, allowNull: false },
      heureFin: { type: Sequelize.TIME, allowNull: false },

      diametreMaille1: { type: Sequelize.STRING(50), allowNull: true },
      diametreMaille2: { type: Sequelize.STRING(50), allowNull: true },
      diametreMaille3: { type: Sequelize.STRING(50), allowNull: true },

      longueur: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      largeur: { type: Sequelize.DECIMAL(10, 2), allowNull: true },

      quantiteGrainPlastique: { type: Sequelize.DECIMAL(10, 2), allowNull: true },

      quantitePromesh1: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      quantitePromesh2: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      quantitePromesh3: { type: Sequelize.DECIMAL(10, 2), allowNull: true },

      demarrageProductionHeure1: { type: Sequelize.TIME, allowNull: true },
      demarrageProductionQuantite1: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      demarrageProductionHeure2: { type: Sequelize.TIME, allowNull: true },
      demarrageProductionQuantite2: { type: Sequelize.DECIMAL(10, 2), allowNull: true },

      responsable1: { type: Sequelize.STRING(255), allowNull: true },
      responsable2: { type: Sequelize.STRING(255), allowNull: true },

      operateur1: { type: Sequelize.STRING(255), allowNull: true },
      operateur2: { type: Sequelize.STRING(255), allowNull: true },

      aideOperateur: { type: Sequelize.STRING(255), allowNull: true },
      manoeuvre: { type: Sequelize.STRING(255), allowNull: true },

      stagiaire1: { type: Sequelize.STRING(255), allowNull: true },
      stagiaire2: { type: Sequelize.STRING(255), allowNull: true },

      observationPersonnel: { type: Sequelize.TEXT, allowNull: true },

      heureFinTravail: { type: Sequelize.TIME, allowNull: true },
      observationFinTravail: { type: Sequelize.TEXT, allowNull: true },

      totalMainOeuvre: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      totalChuteBarres: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      totalDechetGraine: { type: Sequelize.DECIMAL(10, 2), allowNull: true },

      visaProduction: { type: Sequelize.STRING(255), allowNull: true },
      visaControleQualite: { type: Sequelize.STRING(255), allowNull: true },
      visaDirection: { type: Sequelize.STRING(255), allowNull: true },

      createdBy: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex("por_promesh", ["dateProduction"]);
    await queryInterface.addIndex("por_promesh", ["createdBy"]);
    await queryInterface.addIndex("por_promesh", ["createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("por_promesh");
  },
};
