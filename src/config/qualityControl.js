"use strict";

// Configuration du module CONTRÔLE QUALITÉ.
//
// Une FICHE de contrôle qualité (machine + date + poste) porte :
// - plusieurs PRÉLÈVEMENTS périodiques (un par heure de contrôle), chacun avec les
//   contrôles TEMPORELS (scope "reading") ;
// - UN jeu de PARAMÈTRES PHYSIQUES (scope "fiche"), indépendants du temps,
//   propres à la ligne (PROMESH / PROBAR) — jamais dans un prélèvement. L'heure du contrôle appartient au PRÉLÈVEMENT
// (quality_control_readings.readingTime) — ce n'est plus un paramètre
// (l'ancienne clé "heure" reste en base pour les anciennes fiches, ignorée).
//
// PARAMETERS : ne jamais renommer une `key` (stockée en base dans
// quality_control_items.parameterKey). Servie telle quelle au front via
// GET /quality-control/parameters|config : Flutter ne code jamais cette
// liste en dur.
//
// Métadonnées d'affichage :
// - `section` : catégorie du formulaire (voir `sections`) ;
// - `kind` : "number" (saisie texte libre, ex. "> 6") | "text" | "choice"
//   (boutons, `options`) | "conformity" (contrôle binaire Conforme / Non
//   conforme : aucune valeur saisie, la valeur enregistrée suit le statut) ;
// - `unit` : unité affichée à droite du champ, jamais saisie. Renseignée
//   UNIQUEMENT quand elle est définie par le métier (°C, mm, bar) — sinon
//   null : aucune unité inventée ;
// - `options[].tone` : "ok" | "warn" | "nok" — couleur du bouton, et statut
//   Conforme/Non conforme PROPOSÉ au contrôleur (toujours modifiable).

const ABSENT_PRESENT = [
  { value: "Absent", label: "Absent", tone: "ok" },
  { value: "Présent", label: "Présent", tone: "nok" },
];
const CONFORME_NON_CONFORME = [
  { value: "Conforme", label: "Conforme", tone: "ok" },
  { value: "Non conforme", label: "Non conforme", tone: "nok" },
];

// ── PROMESH : CONTRÔLE MACHINE (prélèvement) / CONTRÔLE PRODUIT (fiche) ──
// Un prélèvement PROMESH porte les contrôles de fonctionnement de la MACHINE,
// dans cet ordre, dans une seule catégorie « Contrôle Machine ».
// [clé, libellé PROMESH] — le libellé n'est précisé que s'il diffère de celui
// du paramètre (les paramètres partagés gardent leur libellé pour PROBAR).
const PROMESH_SECTION = "controle_machine";
const PROMESH_READING = Object.freeze([
  ["temperature_machine"],
  ["temperature_eau"],
  ["pression_air_comprime"],
  ["fuite_eau"],
  ["fuite_air_comprime"],
  ["etat_disque_coupe", "ÉTAT DISQUE DE COUPE"],
  ["niveau_bain_graines"],
  // Liée au prélèvement : peut changer d'un prélèvement à l'autre.
  ["vitesse_impression"],
]);
// Caractéristiques du PRODUIT PROMESH : niveau FICHE (section "physique" —
// « Contrôle Produit »), saisies une seule fois, communes aux prélèvements.
const PROMESH_PRODUCT = Object.freeze([
  // Diamètre réel : même paramètre (même clé) pour PROMESH 1 à 3 et PROMESH 4.
  "promesh_diametre_reel",
  "nombre_bar_longueur",
  "nombre_bar_largeur",
  "dimensions_maille",
  "dimensions_cote_1_long",
  "dimensions_cote_2_long",
  "etat_impression",
]);

// Applique la règle PROMESH à un paramètre : contrôle machine → ligne PROMESH
// + présentation propre à PROMESH (`byLine.PROMESH` : catégorie, ordre,
// libellé) ; contrôle produit → conservé tel que défini (niveau fiche) ;
// tout autre paramètre → retiré de PROMESH. La ligne PROBAR d'un paramètre
// n'est jamais modifiée.
function applyPromeshReference(p) {
  const product = PROMESH_PRODUCT.indexOf(p.key);
  if (product >= 0) {
    // Contrôle produit : niveau fiche, dans l'ordre de PROMESH_PRODUCT.
    return { ...p, lines: ["PROMESH", ...p.lines.filter((l) => l !== "PROMESH")], byLine: { PROMESH: { section: "physique", order: product + 1, label: p.label } } };
  }
  // Paramètre propre à une machine (PROMESH 4) : hors de la règle de la ligne.
  if (p.lines.length > 0 && p.lines.every((l) => l.includes(":"))) return { ...p, byLine: {} };
  const index = PROMESH_READING.findIndex(([key]) => key === p.key);
  const others = p.lines.filter((l) => l !== "PROMESH");
  if (index < 0) return { ...p, lines: others, byLine: {} };
  const label = PROMESH_READING[index][1] || p.label;
  return { ...p, scope: "reading", lines: ["PROMESH", ...others], byLine: { PROMESH: { section: PROMESH_SECTION, order: index + 1, label } } };
}

// ── PROMESH 4 : paramètres propres à CETTE machine ──
// La machine 4 de PROMESH a sa propre liste de contrôles, qui REMPLACE celle
// de la ligne (contrôle machine + contrôle produit) pour ses fiches. Elle est
// traitée comme une « ligne » à part, de clé "PROMESH:4" (voir lineKey) :
// `lines` et `byLine` d'un paramètre portent cette clé. Les machines 1 à 3
// gardent la liste PROMESH ; PROBAR n'est pas concerné.
const PROMESH_4 = "PROMESH:4";
const PROMESH_4_SECTION = "controle_promesh_4";
const MACHINE_LINES = Object.freeze([{ type: "PROMESH", machine: "4", key: PROMESH_4 }]);
// CONTRÔLE MACHINE de PROMESH 4 (prélèvement) — [clé, libellé], dans l'ordre d'affichage.
const PROMESH_4_READING = Object.freeze([
  ["promesh4_temperature_machine_1_zone_1"],
  ["promesh4_temperature_machine_1_zone_2"],
  ["promesh4_temperature_machine_2_zone_1"],
  ["promesh4_temperature_machine_2_zone_2"],
  ["temperature_eau"],
  ["promesh4_nombre_bobines"],
  ["promesh4_vitesse_tirage"],
  ["promesh4_viscosite_bain_1"],
  ["promesh4_viscosite_bain_2"],
]);
// CONTRÔLE PRODUIT de PROMESH 4 (niveau fiche) — [clé, libellé pour PROMESH 4],
// dans l'ordre demandé. Les caractéristiques communes avec la ligne PROMESH
// gardent leur clé (les valeurs déjà enregistrées restent affichées).
const PROMESH_4_PRODUCT = Object.freeze([
  ["promesh_diametre_reel"],
  ["dimensions_cote_1_long", "DIMENSIONS CÔTÉ 1 LONGUEUR"],
  ["nombre_bar_longueur"],
  ["dimensions_maille"],
  ["nombre_bar_largeur"],
  ["dimensions_cote_2_long", "DIMENSIONS CÔTÉ 2 LONGUEUR"],
  // « État d'impression » : retiré du contrôle produit de PROMESH 4 (conservé
  // pour PROMESH 1 à 3 ; valeurs déjà enregistrées conservées en base).
]);
// Clé de la liste de paramètres d'une fiche : celle de sa machine quand elle
// a sa propre liste, sinon celle de sa ligne.
const lineKey = (productionType, machine) => {
  const type = String(productionType || "").toUpperCase();
  return MACHINE_LINES.find((m) => m.type === type && m.machine === String(machine ?? "").trim())?.key || type;
};
function applyPromesh4(p) {
  for (const [list, section] of [
    [PROMESH_4_READING, PROMESH_4_SECTION],
    [PROMESH_4_PRODUCT, "physique"],
  ]) {
    const index = list.findIndex(([key]) => key === p.key);
    if (index < 0) continue;
    const lines = p.lines.includes(PROMESH_4) ? p.lines : [...p.lines, PROMESH_4];
    return { ...p, lines, byLine: { ...p.byLine, [PROMESH_4]: { section, order: index + 1, label: list[index][1] || p.label } } };
  }
  return p;
}

const PARAMETERS = [
  // A — Paramètres de ligne
  {
    key: "niveau_bain_graines",
    label: "NIVEAU BAIN DE GRAINES",
    section: "ligne",
    kind: "choice",
    // PROMESH uniquement (contrôle machine).
    lines: ["PROMESH"],
    options: [
      { value: "Bien", label: "Bien", tone: "ok" },
      { value: "Moyen", label: "Moyen", tone: "warn" },
      { value: "Mauvais", label: "Mauvais", tone: "nok" },
    ],
  },
  // PROBAR suit le processus réel de fabrication des barres : ses propres
  // contrôles de ligne (nouvelles clés — une ancienne valeur « vitesse de
  // tirage » ou « nombre de rovings » n'est jamais relue sous un autre nom).
  // Les anciens contrôles retirés de PROBAR restent en base, plus affichés.
  { key: "vitesse_tirage", label: "VITESSE DE TIRAGE", section: "ligne", kind: "number", lines: ["PROMESH"] },
  { key: "variateur_frequence_tirage", label: "VARIATEUR EN FRÉQUENCE DE TIRAGE", section: "ligne", kind: "number", lines: ["PROBAR"] },
  // PROBAR — paramètres de ligne actuels : variateur de tirage, variateur de
  // bobinage, vitesse de barre, nombre de bobines, alignement des fibres.
  { key: "variateur_frequence_bobinage", label: "VARIATEUR EN FRÉQUENCE DE BOBINAGE", section: "ligne", kind: "number", lines: ["PROBAR"] },
  // Mètre linéaire par minute : l'unité fait partie du libellé demandé.
  { key: "vitesse_barre", label: "VITESSE DE BARRE (m/min)", section: "ligne", kind: "number", lines: ["PROBAR"] },
  // Retirés de PROBAR (`lines` vide) : valeurs historiques conservées en base.
  { key: "vitesse_tirage_bobinage", label: "VITESSE DE TIRAGE DE BOBINAGE", section: "ligne", kind: "number", lines: [] },
  { key: "vitesse_alimentation_fibres", label: "VITESSE D'ALIMENTATION DES FIBRES", section: "ligne", kind: "number", lines: [] },
  // Rovings : retirés des prélèvements PROBAR puis PROMESH (`lines` vide) — les
  // valeurs déjà enregistrées restent en base, simplement plus affichées.
  { key: "tension_rovings", label: "TENSION DES ROVINGS", section: "ligne", kind: "number", lines: [] },
  { key: "nombre_rovings", label: "NOMBRE DE ROVINGS", section: "ligne", kind: "number", lines: [] },
  { key: "nombre_bobines", label: "NOMBRE DE BOBINES", section: "ligne", kind: "number", lines: ["PROBAR"] },
  // Mètre linéaire par minute : l'unité fait partie du libellé demandé.
  { key: "vitesse_bobinage", label: "VITESSE DE BOBINAGE (m/min)", section: "ligne", kind: "number", lines: [] },
  { key: "alignement_fibres", label: "ALIGNEMENT DES FIBRES", section: "ligne", kind: "choice", options: CONFORME_NON_CONFORME },

  // B — Chauffage / imprégnation
  // PROBAR — trois zones de chauffage saisies et enregistrées SÉPARÉMENT (une
  // ligne par zone en base), à la place de l'ancien champ unique « Température
  // des différentes zones » (retiré, valeurs historiques conservées).
  { key: "temperature_zone_1", label: "TEMPÉRATURE ZONE 1", section: "chauffage", kind: "number", unit: "°C", lines: ["PROBAR"] },
  { key: "temperature_zone_2", label: "TEMPÉRATURE ZONE 2", section: "chauffage", kind: "number", unit: "°C", lines: ["PROBAR"] },
  { key: "temperature_zone_3", label: "TEMPÉRATURE ZONE 3", section: "chauffage", kind: "number", unit: "°C", lines: ["PROBAR"] },
  // Remplace « Pression / conditions d'imprégnation » (retiré).
  { key: "pression_air", label: "PRESSION D'AIR", section: "chauffage", kind: "number", lines: ["PROBAR"] },
  { key: "temperature_zones_chauffage", label: "TEMPÉRATURE DES DIFFÉRENTES ZONES DE CHAUFFAGE", section: "chauffage", kind: "text", unit: "°C", lines: [] },
  { key: "temperature_filiere", label: "TEMPÉRATURE DE LA FILIÈRE", section: "chauffage", kind: "number", unit: "°C", lines: ["PROMESH"] },
  { key: "pression_impregnation", label: "PRESSION / CONDITIONS D'IMPRÉGNATION", section: "chauffage", kind: "text", lines: [] },
  { key: "viscosite_resine", label: "VISCOSITÉ DE LA RÉSINE", section: "chauffage", kind: "number" },
  // PROBAR — contrôle binaire Conforme / Non conforme, sans valeur saisie
  // (les ratios saisis auparavant restent en base et dans l'historique).
  { key: "ratio_resine_durcisseur_catalyseur", label: "RATIO RÉSINE / DURCISSEUR / CATALYSEUR", section: "chauffage", kind: "conformity" },

  // C — Polymérisation : PROMESH uniquement (section retirée de PROBAR).
  { key: "temps_gel", label: "TEMPS DE GEL", section: "polymerisation", kind: "number", lines: ["PROMESH"] },
  { key: "degre_polymerisation", label: "DEGRÉ DE POLYMÉRISATION", section: "polymerisation", kind: "number", lines: ["PROMESH"] },
  { key: "vitesse_polymerisation", label: "VITESSE DE POLYMÉRISATION", section: "polymerisation", kind: "number", lines: ["PROMESH"] },

  // D — Barre
  // D — Barre : contrôles propres aux BARRES (PROBAR) — jamais affichés
  // ni acceptés pour PROMESH (treillis).
  // DIAMÈTRE DE BAR : retiré de PROBAR puis de PROMESH — plus aucune ligne
  // (ni proposé, ni affiché, ni accepté). Conservé pour le libellé des valeurs
  // historiques ; rien n'est supprimé en base.
  { key: "diametre_bar", label: "DIAMÈTRE DE BAR", section: "barre", kind: "number", unit: "mm", lines: [] },
  // Section « Barre » retirée de PROBAR : plus aucun paramètre affichable.
  { key: "ovalisation", label: "OVALISATION", section: "barre", kind: "number", unit: "mm", lines: [] },
  { key: "etat_surface", label: "ÉTAT DE SURFACE", section: "barre", kind: "choice", options: CONFORME_NON_CONFORME, lines: [] },
  { key: "revetement", label: "QUANTITÉ ET RÉGULARITÉ DU REVÊTEMENT", section: "barre", kind: "text", lines: [] },

  // E — Refroidissement / coupe
  // PROMESH : contrôle d'un prélèvement. PROBAR : refroidissement et coupe sont des
  // PARAMÈTRES PHYSIQUES de la fiche (phys_vitesse_refroidissement,
  // phys_vitesse_coupe, phys_longueur_coupe — voir plus bas). Les valeurs
  // saisies par prélèvement sur les anciennes fiches PROBAR restent en base et
  // sont reprises à l'affichage (`legacyKey`).
  { key: "vitesse_refroidissement", label: "VITESSE DE REFROIDISSEMENT", section: "coupe", kind: "number", lines: ["PROMESH"] },
  // Coupe de la barre : PROBAR uniquement.
  { key: "vitesse_coupe", label: "VITESSE DE COUPE", section: "coupe", kind: "number", lines: [] },
  { key: "longueur_coupe", label: "LONGUEUR DE COUPE", section: "coupe", kind: "number", unit: "mm", lines: [] },

  // F — Machine
  // Retirée de PROBAR, conservée pour PROMESH (valeurs PROBAR déjà saisies conservées en base).
  { key: "temperature_machine", label: "TEMPÉRATURE DE MACHINE", section: "machine", kind: "number", unit: "°C", lines: ["PROMESH"] },
  { key: "temperature_eau", label: "TEMPÉRATURE D'EAU", section: "machine", kind: "number", unit: "°C" },
  // Pression d'air comprimé : retirée de PROBAR, conservée pour PROMESH (valeurs
  // PROBAR déjà saisies conservées en base).
  { key: "pression_air_comprime", label: "PRESSION D'AIR COMPRIMÉ", section: "machine", kind: "number", unit: "bar", lines: ["PROMESH"] },
  { key: "fuite_air_comprime", label: "FUITE D'AIR COMPRIMÉ", section: "machine", kind: "choice", options: ABSENT_PRESENT },
  { key: "fuite_eau", label: "FUITE D'EAU", section: "machine", kind: "choice", options: ABSENT_PRESENT },
  {
    key: "etat_disque_coupe",
    label: "ÉTAT DU DISQUE DE COUPE",
    section: "machine",
    kind: "choice",
    options: [
      { value: "OK", label: "OK", tone: "ok" },
      { value: "NOK", label: "NOK", tone: "nok" },
    ],
  },


  // ── PARAMÈTRES PHYSIQUES — niveau FICHE (scope "fiche") ────────────────
  // Indépendants du temps : saisis UNE fois pour la fiche, jamais dupliqués
  // par prélèvement, jamais dans un prélèvement. Propres à chaque ligne (`lines`).

  // PROMESH : paramètres physiques déjà définis dans le module, conservés.
  // Contrôles d'un PRÉLÈVEMENT PROMESH (fiche de référence — voir
  // PROMESH_READING plus bas) : saisis à chaque prélèvement, plus au niveau
  // de la fiche. Les valeurs de niveau fiche déjà enregistrées restent en
  // base, simplement plus affichées.
  // ── CONTRÔLE PRODUIT PROMESH — niveau FICHE ──
  // Caractéristiques du produit : saisies UNE fois pour la fiche, jamais
  // recréées par prélèvement. `legacyKey` (même clé) : valeur saisie dans un
  // prélèvement avant ce passage au niveau fiche, reprise tant que la fiche
  // n'a pas sa propre valeur — rien n'est réécrit ni supprimé en base.
  { key: "nombre_bar_longueur", label: "NOMBRE DE BARRES EN LONGUEUR", section: "physique", kind: "number", scope: "fiche", lines: ["PROMESH"], legacyKey: "nombre_bar_longueur" },
  { key: "nombre_bar_largeur", label: "NOMBRE DE BARRES EN LARGEUR", section: "physique", kind: "number", scope: "fiche", lines: ["PROMESH"], legacyKey: "nombre_bar_largeur" },
  { key: "dimensions_maille", label: "DIMENSIONS DE MAILLE", section: "physique", kind: "text", hint: "ex. 20 × 20 mm", scope: "fiche", lines: ["PROMESH"], legacyKey: "dimensions_maille" },
  { key: "dimensions_cote_1_long", label: "DIMENSIONS CÔTÉ 1 LONG", section: "physique", kind: "number", unit: "mm", scope: "fiche", lines: ["PROMESH"], legacyKey: "dimensions_cote_1_long" },
  { key: "dimensions_cote_2_long", label: "DIMENSIONS CÔTÉ 2 LONG", section: "physique", kind: "number", unit: "mm", scope: "fiche", lines: ["PROMESH"] },
  { key: "etat_impression", label: "ÉTAT D'IMPRESSION", section: "physique", kind: "choice", options: CONFORME_NON_CONFORME, scope: "fiche", lines: ["PROMESH"], legacyKey: "etat_impression" },
  // Contrôle MACHINE du prélèvement (voir PROMESH_READING). Aucune unité indiquée
  // par le métier : aucune unité affichée.
  { key: "vitesse_impression", label: "VITESSE D'IMPRESSION", section: "machine", kind: "number", lines: ["PROMESH"] },

  // PROBAR : valeur libre, sans unité imposée (aucune unité inventée).
  ...[
    ["phys_diametre_nominal", "DIAMÈTRE NOMINAL"],
    ["phys_diametre_reel", "DIAMÈTRE RÉEL"],
    ["phys_section_transversale", "SECTION TRANSVERSALE"],
    ["phys_ovalisation", "OVALISATION", false],
    ["phys_longueur", "LONGUEUR"],
    // « Masse linéique » renommée « Poids en g » (même clé : les valeurs déjà
    // saisies restent affichées).
    ["phys_masse_lineique", "POIDS EN g"],
    ["phys_rectitude", "RECTITUDE", false],
    // Ancienne saisie libre du pas : retirée, remplacée par le choix OK / NOK
    // (phys_pas_profil_surface_controle, plus bas).
    ["phys_pas_profil_surface", "PAS DU PROFIL DE SURFACE", false],
    // Retirés des paramètres physiques PROBAR (`false` → `lines` vide : plus
    // proposés ni affichés ; valeurs historiques conservées en base).
    ["phys_hauteur_nervures", "HAUTEUR / PROFONDEUR DES NERVURES OU ENROULEMENT", false],
    ["phys_regularite_revetement", "RÉGULARITÉ DU REVÊTEMENT", false],
    // Ancienne saisie libre : retirée, remplacée par le choix OK / NOK
    // (phys_defauts_superficiels_controle, plus bas).
    ["phys_defauts_superficiels", "DÉFAUTS SUPERFICIELS", false],
  ].map(([key, label, active = true]) => ({ key, label, section: "physique", kind: "text", scope: "fiche", lines: active ? ["PROBAR"] : [] })),
  // Refroidissement / coupe : déplacés des prélèvements vers les paramètres
  // physiques PROBAR (saisis UNE fois pour la fiche). `legacyKey` : ancien
  // contrôle de prélèvement dont la valeur est reprise quand la fiche n'en a pas.
  // Unités : seulement celles déjà définies (mm) — aucune unité inventée.
  // Retirée du contrôle produit PROBAR (`lines` vide).
  { key: "phys_vitesse_refroidissement", label: "VITESSE DE REFROIDISSEMENT", section: "physique", kind: "number", scope: "fiche", lines: [], legacyKey: "vitesse_refroidissement" },
  // PAS DU PROFIL DE SURFACE : choix OK / NOK, jamais une saisie. Nouvelle
  // clé : une ancienne valeur saisie n'est jamais relue comme un choix.
  {
    key: "phys_pas_profil_surface_controle",
    label: "PAS DU PROFIL DE SURFACE",
    section: "physique",
    kind: "choice",
    scope: "fiche",
    // Retiré du contrôle produit PROBAR (remplacé par « Défauts superficiels »).
    lines: [],
    options: [
      { value: "OK", label: "OK", tone: "ok" },
      { value: "NOK", label: "NOK", tone: "nok" },
    ],
  },
  // Vitesse et longueur de coupe : retirées (`lines` vide), remplacées par
  // la QUALITÉ DE COUPE — un choix Bon / Pas bon (valeur BON | PAS_BON),
  // jamais une saisie numérique. Nouvelle clé : une ancienne vitesse n'est
  // jamais relue comme une qualité.
  { key: "phys_vitesse_coupe", label: "VITESSE DE COUPE", section: "physique", kind: "number", scope: "fiche", lines: [], legacyKey: "vitesse_coupe" },
  { key: "phys_longueur_coupe", label: "LONGUEUR DE COUPE", section: "physique", kind: "number", unit: "mm", scope: "fiche", lines: [], legacyKey: "longueur_coupe" },
  // DÉFAUTS SUPERFICIELS : choix OK / NOK, jamais une saisie. Nouvelle clé :
  // un ancien texte saisi n'est jamais relu comme un choix.
  {
    key: "phys_defauts_superficiels_controle",
    label: "DÉFAUTS SUPERFICIELS",
    section: "physique",
    kind: "choice",
    scope: "fiche",
    lines: ["PROBAR"],
    options: [
      { value: "OK", label: "OK", tone: "ok" },
      { value: "NOK", label: "NOK", tone: "nok" },
    ],
  },
  {
    key: "phys_qualite_coupe",
    label: "QUALITÉ DE COUPE",
    section: "physique",
    kind: "choice",
    scope: "fiche",
    lines: ["PROBAR"],
    options: [
      { value: "BON", label: "Bon", tone: "ok" },
      { value: "PAS_BON", label: "Pas bon", tone: "nok" },
    ],
  },
  // Retirée du contrôle produit PROBAR (`lines` vide).
  { key: "phys_ceinture_tirage", label: "CEINTURE DE TIRAGE", section: "physique", kind: "text", scope: "fiche", lines: [] },

  // ── PARAMÈTRES SPÉCIFIQUES PROMESH (treillis GFRP) — niveau FICHE ──────
  // Indépendant des prélèvements. Chaque paramètre porte une valeur, un statut
  // (Conforme / Non conforme / Non contrôlé) et une remarque (withStatus).
  // Valeur libre, sans unité imposée (aucune unité inventée).
  ...[
    // Contrôle actuel : 6 paramètres de GÉOMÉTRIE. Les paramètres marqués `false`
    // (3 de géométrie, toutes les sections Assemblage et Mécanique) sont RETIRÉS :
    // `lines` vide = plus proposés, affichés ni acceptés. Ils restent ici pour le
    // libellé des valeurs historiques — rien n'est supprimé en base.
    // A — Géométrie
    ["treillis_geometrie", "treillis_largeur", "LARGEUR"],
    ["treillis_geometrie", "treillis_longueur", "LONGUEUR"],
    ["treillis_geometrie", "treillis_maille_longitudinale", "MAILLE LONGITUDINALE"],
    ["treillis_geometrie", "treillis_maille_transversale", "MAILLE TRANSVERSALE"],
    ["treillis_geometrie", "treillis_diametre_section", "DIAMÈTRE / SECTION DES ÉLÉMENTS", false],
    ["treillis_geometrie", "treillis_tolerance_dimensionnelle", "TOLÉRANCE DIMENSIONNELLE", false],
    ["treillis_geometrie", "treillis_espacement_fils", "ESPACEMENT DES FILS", false],
    ["treillis_geometrie", "treillis_poids_m2", "POIDS PAR M²"],
    ["treillis_geometrie", "treillis_rectitude_planeite", "RECTITUDE / PLANÉITÉ"],
    // B — Assemblage
    ["treillis_assemblage", "treillis_qualite_intersections", "QUALITÉ DES INTERSECTIONS", false],
    ["treillis_assemblage", "treillis_positionnement_fils", "POSITIONNEMENT DES FILS", false],
    ["treillis_assemblage", "treillis_continuite_elements", "CONTINUITÉ DES ÉLÉMENTS", false],
    ["treillis_assemblage", "treillis_qualite_point_liaison", "QUALITÉ DU POINT DE LIAISON", false],
    ["treillis_assemblage", "treillis_resistance_intersection", "RÉSISTANCE DE L'INTERSECTION", false],
    ["treillis_assemblage", "treillis_absence_delamination", "ABSENCE DE DÉLAMINATION / DÉFAUT", false],
    // C — Mécanique
    ["treillis_mecanique", "treillis_traction_longitudinale", "RÉSISTANCE EN TRACTION LONGITUDINALE", false],
    ["treillis_mecanique", "treillis_traction_transversale", "RÉSISTANCE EN TRACTION TRANSVERSALE", false],
    ["treillis_mecanique", "treillis_module", "MODULE", false],
    ["treillis_mecanique", "treillis_deformation", "DÉFORMATION", false],
    ["treillis_mecanique", "treillis_resistance_liaison", "RÉSISTANCE DE L'INTERSECTION / LIAISON", false],
  ].map(([section, key, label, active = true]) => ({ key, label, section, kind: "text", scope: "fiche", lines: active ? ["PROMESH"] : [], withStatus: true })),

  // ── PROMESH 4 uniquement (nouvelles clés : aucune ancienne valeur n'est
  // relue sous un autre nom). Températures en °C (unité déjà définie pour
  // les températures) ; vitesse et viscosité : saisie libre, sans unité.
  // Température unique par machine : remplacée par deux zones (`lines` vide).
  { key: "promesh4_temperature_machine_1", label: "TEMPÉRATURE MACHINE 1", section: PROMESH_4_SECTION, kind: "number", unit: "°C", lines: [] },
  { key: "promesh4_temperature_machine_2", label: "TEMPÉRATURE MACHINE 2", section: PROMESH_4_SECTION, kind: "number", unit: "°C", lines: [] },
  { key: "promesh4_nombre_bobines", label: "NOMBRE DE BOBINES", section: PROMESH_4_SECTION, kind: "number", lines: [PROMESH_4] },
  { key: "promesh4_vitesse_tirage", label: "VITESSE DE TIRAGE", section: PROMESH_4_SECTION, kind: "number", lines: [PROMESH_4] },
  // Viscosité de la résine : deux bains, deux valeurs enregistrées séparément.
  // `group` : sous-titre commun ; `shortLabel` : libellé du champ dans le groupe.
  // Viscosité saisie en degrés (°), comme demandé.
  { key: "promesh4_viscosite_bain_1", label: "VISCOSITÉ DE LA RÉSINE — BAIN 1", section: PROMESH_4_SECTION, kind: "number", unit: "°", lines: [PROMESH_4], group: "VISCOSITÉ DE LA RÉSINE", shortLabel: "BAIN 1" },
  { key: "promesh4_viscosite_bain_2", label: "VISCOSITÉ DE LA RÉSINE — BAIN 2", section: PROMESH_4_SECTION, kind: "number", unit: "°", lines: [PROMESH_4], group: "VISCOSITÉ DE LA RÉSINE", shortLabel: "BAIN 2" },
  // Températures machine 1 et 2 : deux zones chacune, enregistrées séparément (°C).
  ...[1, 2].flatMap((m) =>
    [1, 2].map((z) => ({
      key: `promesh4_temperature_machine_${m}_zone_${z}`,
      label: `TEMPÉRATURE MACHINE ${m} — ZONE ${z}`,
      section: PROMESH_4_SECTION,
      kind: "number",
      unit: "°C",
      lines: [PROMESH_4],
      group: `TEMPÉRATURE MACHINE ${m}`,
      shortLabel: `ZONE ${z}`,
    }))
  ),
  // Contrôle produit PROMESH (machines 1 à 4) : diamètre réel (saisie libre, niveau fiche).
  { key: "promesh_diametre_reel", label: "DIAMÈTRE RÉEL", section: "physique", kind: "text", scope: "fiche", lines: [PROMESH_4] },
]
  .map((p, i) => ({ autoTime: false, unit: null, options: [], hint: null, scope: "reading", lines: ["PROMESH", "PROBAR"], withStatus: false, legacyKey: null, group: null, shortLabel: null, ...p, position: i + 1 }))
  .map(applyPromeshReference)
  .map(applyPromesh4)
  .map((p) => Object.freeze(p));

// Contrôles TEMPORELS d'un prélèvement (mêmes paramètres pour chaque prélèvement et
// pour les deux lignes).
const READING_PARAMETERS = Object.freeze(PARAMETERS.filter((p) => p.scope === "reading"));
const forLine = (productionType) => {
  const type = String(productionType || "").toUpperCase();
  return (p) => p.lines.includes(type);
};
// Contrôles d'un prélèvement pour UNE ligne : PROMESH (treillis) ne reçoit jamais
// les contrôles propres aux barres (PROBAR).
// Paramètre tel qu'il se présente pour UNE ligne (catégorie, ordre et libellé
// propres à la ligne quand ils existent — PROMESH).
const forLineView = (productionType) => {
  const type = String(productionType || "").toUpperCase();
  return (p) => (p.byLine[type] ? Object.freeze({ ...p, section: p.byLine[type].section, label: p.byLine[type].label, order: p.byLine[type].order }) : p);
};
const readingParametersFor = (productionType) =>
  READING_PARAMETERS.filter(forLine(productionType))
    .map(forLineView(productionType))
    .sort((a, b) => (a.order ?? a.position) - (b.order ?? b.position));
// Paramètres de niveau FICHE d'une ligne (indépendants des prélèvements) :
// - physiques (section "physique") ;
// - contrôle spécifique (sections "treillis_*" — PROMESH uniquement).
// Libellé et ordre propres à la liste quand ils existent (PROMESH 4).
const ficheParameters = (productionType) =>
  PARAMETERS.filter((p) => p.scope === "fiche")
    .filter(forLine(productionType))
    .map(forLineView(productionType))
    .sort((a, b) => (a.order ?? a.position) - (b.order ?? b.position));
const physicalParameters = (productionType) => ficheParameters(productionType).filter((p) => p.section === "physique");
const specificParameters = (productionType) => ficheParameters(productionType).filter((p) => p.section !== "physique");

// Lignes de production contrôlables et leurs machines — EXACTEMENT celles du
// module Production (écrans PROMESH/PROBAR : Machine 1..4, voir Flutter
// MachineOverviewScreen et le sous-menu machines du sidebar). Aucune machine
// inventée : modifier ici si le module Production change.
const PRODUCTION_LINES = Object.freeze([
  { type: "PROMESH", label: "PROMESH", machines: ["1", "2", "3", "4"] },
  { type: "PROBAR", label: "PROBAR", machines: ["1", "2", "3", "4"] },
]);

const list = (v) => (v ? String(v).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null);

module.exports = {
  timezone: "Africa/Tunis",

  // Rôle dédié (voir migration 20260925090000). Seul `controle_qualite`
  // crée/remplit/valide/modifie un contrôle ; les rôles admin CONSULTENT
  // (liste, détail, historique) et peuvent supprimer (logiquement) — jamais
  // saisir. controle_qualite est owner-scoped (ne voit que ses contrôles).
  role: "controle_qualite",
  writeRoles: ["controle_qualite"],
  readRoles: ["controle_qualite", "admin", "superadmin", "superadmin2"],
  // Suppression : BROUILLONS uniquement (un contrôle validé est en lecture
  // seule pour tous — voir service#assertDraft). controle_qualite supprime
  // ses propres brouillons (owner-scoped), les admins tout brouillon.
  deleteRoles: ["controle_qualite", "admin", "superadmin", "superadmin2"],

  parameters: Object.freeze(PARAMETERS),
  readingParameters: READING_PARAMETERS,
  readingParametersFor,
  ficheParameters,
  physicalParameters,
  specificParameters,
  productionLines: PRODUCTION_LINES,
  // Machines qui ont leur propre liste de paramètres (clé de liste — voir lineKey).
  machineLines: MACHINE_LINES,
  lineKey,
  // Poste du contrôle (liste déroulante Matin / Soir). Les anciennes valeurs
  // copiées de la fiche ("nuit") restent en base tant que l'utilisateur ne
  // choisit pas — jamais converties automatiquement.
  postes: Object.freeze(["matin", "soir"]),
  // Catégories du formulaire d'un prélèvement (ordre d'affichage).
  sections: Object.freeze([
    // Catégorie unique d'un prélèvement PROMESH : le contrôle de la machine.
    { key: "controle_machine", label: "Contrôle Machine" },
    // Catégorie unique d'un prélèvement PROMESH 4 (paramètres propres à la machine).
    { key: "controle_promesh_4", label: "Contrôle Machine" },
    { key: "ligne", label: "Paramètres de ligne" },
    { key: "chauffage", label: "Chauffage / imprégnation" },
    { key: "polymerisation", label: "Polymérisation" },
    { key: "barre", label: "Barre" },
    { key: "coupe", label: "Refroidissement / coupe" },
    { key: "machine", label: "Machine" },
    // Niveau fiche : hors des prélèvements (voir scope "fiche").
    { key: "physique", label: "Contrôle produit", scope: "fiche", group: "physique" },
    // Contrôle spécifique des treillis GFRP (PROMESH) : trois sous-sections.
    { key: "treillis_geometrie", label: "Géométrie", scope: "fiche", group: "treillis" },
    { key: "treillis_assemblage", label: "Assemblage", scope: "fiche", group: "treillis" },
    { key: "treillis_mecanique", label: "Mécanique", scope: "fiche", group: "treillis" },
  ]),
  // Cadence RECOMMANDÉE entre deux prélèvements (suggestion de l'heure du
  // prélèvement suivant) — jamais imposée : le contrôleur saisit l'heure réelle.
  readingIntervalMinutes: 180,

  // Destinataires des notifications internes "Contrôle qualité non conforme" :
  // par défaut les responsables Production déjà configurés pour Production
  // Compliance (PRODUCTION_COMPLIANCE_MANAGERS) — surcharge possible via
  // QUALITY_CONTROL_NOTIFY_RECIPIENTS. Jamais d'email client.
  get notifyRecipients() {
    return list(process.env.QUALITY_CONTROL_NOTIFY_RECIPIENTS) || require("./productionCompliance").managers;
  },
};
