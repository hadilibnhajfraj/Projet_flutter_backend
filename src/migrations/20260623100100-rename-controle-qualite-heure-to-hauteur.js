"use strict";

// "Heure" n'avait pas de sens pour une ligne de contrôle qualité (mesure
// dimensionnelle, pas un horodatage) — renommé en "Hauteur" et retypé en
// DECIMAL pour rejoindre maille/longueur/largeur.
module.exports = {
  async up(queryInterface) {
    await queryInterface.renameColumn("por_promesh_controles_qualite", "heure", "hauteur");
    // TIME -> DECIMAL n'a pas de cast implicite côté Postgres, et les
    // anciennes valeurs horaires n'ont aucun sens en tant que hauteur :
    // on repart à NULL plutôt que de tenter une conversion arbitraire.
    await queryInterface.sequelize.query(
      `ALTER TABLE "por_promesh_controles_qualite" ALTER COLUMN "hauteur" TYPE DECIMAL(10,2) USING NULL`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "por_promesh_controles_qualite" ALTER COLUMN "hauteur" TYPE TIME USING NULL`
    );
    await queryInterface.renameColumn("por_promesh_controles_qualite", "hauteur", "heure");
  },
};
