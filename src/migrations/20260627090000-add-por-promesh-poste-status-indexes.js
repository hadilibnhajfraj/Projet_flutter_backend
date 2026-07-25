"use strict";

// machine, dateProduction et createdAt sont déjà indexés (migrations
// 20260622110000 et 20260624120000) — poste et status manquaient alors que
// "machine + poste" est le filtre dominant de toutes les requêtes du
// Dashboard du poste opérateur.
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex("por_promesh", ["poste"]);
    await queryInterface.addIndex("por_promesh", ["status"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("por_promesh", ["poste"]);
    await queryInterface.removeIndex("por_promesh", ["status"]);
  },
};
