"use strict";

// Gammes de produit disponibles pour un projet (mode "project" uniquement)
// et diamètres valides par gamme — donnée de référence statique, jamais
// stockée sous forme de texte concaténé (voir Project.productFamily /
// Project.diameterMm) ; le libellé ("Probar Ø12 mm") est toujours recalculé
// à l'affichage à partir de ces deux colonnes.
const PRODUCT_FAMILIES = ["PROBAR", "PROMESH"];

const DIAMETERS_BY_FAMILY = {
  PROBAR: [4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32],
  PROMESH: [4, 5, 6, 8, 10],
};

module.exports = { PRODUCT_FAMILIES, DIAMETERS_BY_FAMILY };
