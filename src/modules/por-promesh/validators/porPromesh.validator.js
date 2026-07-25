const Joi = require("joi");

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

// NOTE : pour un champ numérique/enum, `.allow(null, "")` ne fait que
// *tolérer* la chaîne vide — elle ressort telle quelle ("") et provoque
// ensuite une erreur Postgres ("invalid input syntax for type ...") à
// l'insertion. `.empty("")` la convertit proprement en `undefined` (donc
// `NULL` en base) avant d'atteindre Sequelize.

// ── por_promesh_controles_qualite ──────────────────────────
// Souple ici (brouillon) — le caractère obligatoire de chaque champ
// (heure/numeroPlaque/maille/longueur/largeur/statut) n'est imposé
// que côté front via `canFinish` (cf. PorPromeshController.controleProduitSaved),
// même pattern que dateProduction/heureDebut/heureFin sur la fiche parente.
// `hauteur` supprimée — plus acceptée nulle part (stripUnknown: true, voir
// `validate()` plus bas, l'ignore silencieusement si un vieux client
// l'envoie encore).
const controleQualiteSchema = Joi.object({
  heure: Joi.string().max(20).allow(null, "").optional(),
  numeroPlaque: Joi.string().max(100).allow(null, "").optional(),
  maille: Joi.string().max(50).allow(null, "").optional(),
  longueur: Joi.number().allow(null).empty("").optional(),
  largeur: Joi.number().allow(null).empty("").optional(),
  statutCOQ: Joi.string().valid("C", "NC").allow(null).empty("").optional(),
});

// ── por_promesh_arrets_machine ──────────────────────────────
const arretMachineSchema = Joi.object({
  tArret: Joi.string().max(255).allow(null, "").optional(),
  observationMachine: Joi.string().max(2000).allow(null, "").optional(),
});

// ── por_promesh_consommations ───────────────────────────────
const consommationSchema = Joi.object({
  designationArticle: Joi.string().max(255).allow(null, "").optional(),
  metrage: Joi.number().min(0).allow(null).empty("").optional(),
  observation: Joi.string().max(2000).allow(null, "").optional(),
});

// ── por_promesh_non_conformites ──────────────────────────────
const nonConformiteSchema = Joi.object({
  typeNC: Joi.string().max(255).allow(null, "").optional(),
  gravite: Joi.string().valid("faible", "moyenne", "critique").allow(null, "").empty("").optional(),
  description: Joi.string().max(5000).allow(null, "").optional(),
  photoUrl: Joi.string().max(500).allow(null, "").optional(),
});

// ── por_promesh_process_control ─────────────────────────────
const processControlSchema = Joi.object({
  bloc: Joi.string()
    .valid("controle_08h20", "controle_10h20", "controle_14h20")
    .required(),
  parametre: Joi.string().max(255).allow(null, "").optional(),
  valeurP1: Joi.string().max(50).allow(null, "").optional(),
  corP1: Joi.boolean().allow(null).optional(),
  valeurP2: Joi.string().max(50).allow(null, "").optional(),
  corP2: Joi.boolean().allow(null).optional(),
});

const baseFields = {
  // Saisis par l'utilisateur à l'étape "Informations générales" du parcours
  // opérateur — plus jamais générés automatiquement. La fiche brouillon doit
  // pouvoir être créée avant que ces 3 champs soient renseignés ; ils ne
  // deviennent obligatoires qu'au moment du verrouillage définitif
  // (POST /:id/validate — cf. validatePorPromesh dans le service).
  dateProduction: Joi.date().iso().allow(null).optional(),
  heureDebut: Joi.string().pattern(TIME_PATTERN).allow("", null).optional(),
  heureFin: Joi.string().pattern(TIME_PATTERN).allow("", null).optional(),
  // Opérateur connecté (sélectionné manuellement) — même étape que les 3 champs ci-dessus.
  operateur: Joi.string().max(255).allow(null, "").optional(),

  machine: Joi.string().max(10).allow(null, "").optional(),
  poste: Joi.string().valid("matin", "nuit").allow(null, "").empty("").optional(),

  diametreMaille1: Joi.string().max(50).allow(null, "").optional(),
  diametreMaille2: Joi.string().max(50).allow(null, "").optional(),
  diametreMaille3: Joi.string().max(50).allow(null, "").optional(),

  // ── Module Rendement (parcours opérateur simplifié) — toujours en m².
  productionM2: Joi.number().min(0).allow(null).optional(),

  demarrageProductionHeure1: Joi.string().pattern(TIME_PATTERN).allow(null, "").optional(),
  demarrageProductionQuantite1: Joi.number().min(0).allow(null).optional(),
  demarrageProductionHeure2: Joi.string().pattern(TIME_PATTERN).allow(null, "").optional(),
  demarrageProductionQuantite2: Joi.number().min(0).allow(null).optional(),

  responsable1: Joi.string().max(255).allow(null, "").optional(),
  responsable2: Joi.string().max(255).allow(null, "").optional(),
  operateur1: Joi.string().max(255).allow(null, "").optional(),
  operateur2: Joi.string().max(255).allow(null, "").optional(),
  aideOperateur: Joi.string().max(255).allow(null, "").optional(),
  manoeuvre: Joi.string().max(255).allow(null, "").optional(),
  stagiaire1: Joi.string().max(255).allow(null, "").optional(),
  stagiaire2: Joi.string().max(255).allow(null, "").optional(),
  observationPersonnel: Joi.string().max(5000).allow(null, "").optional(),

  heureFinTravail: Joi.string().pattern(TIME_PATTERN).allow(null, "").optional(),
  observationFinTravail: Joi.string().max(5000).allow(null, "").optional(),

  totalMainOeuvre: Joi.number().min(0).allow(null).optional(),
  totalChuteBarres: Joi.number().min(0).allow(null).optional(),
  totalDechetGraine: Joi.number().min(0).allow(null).optional(),

  visaProduction: Joi.string().max(255).allow(null, "").optional(),
  visaControleQualite: Joi.string().max(255).allow(null, "").optional(),
  visaDirection: Joi.string().max(255).allow(null, "").optional(),

  // ── Étape 2 — Plan de Process PROMESH ───────────────────
  // `bainResine`, `etatAtelier`, `zoneStockage` supprimés (module "Contrôle
  // Machine") — `stripUnknown: true` (voir `validate()` plus bas) les
  // retire silencieusement de tout payload qui les enverrait encore
  // (anciens clients/fiches), sans jamais lever d'erreur.
  air: Joi.string().max(50).allow(null, "").optional(),
  niveauBainEau: Joi.string().max(50).allow(null, "").optional(),
  temperatureEau: Joi.number().allow(null).empty("").optional(),
  // Anciennement `temperatureDemandee` (renommé) — saisie libre.
  temperaturePistons: Joi.number().allow(null).empty("").optional(),
  etatPistons: Joi.string().max(50).allow(null, "").optional(),
  fluideVisuel: Joi.string().max(50).allow(null, "").optional(),
  etatDisqueCoupe: Joi.string().max(50).allow(null, "").optional(),

  observationsGenerales: Joi.string().max(5000).allow(null, "").optional(),
  justificationControleProcess: Joi.string().max(5000).allow(null, "").optional(),
  justificationControleMachine: Joi.string().max(5000).allow(null, "").optional(),
  visaResponsableLogistiqueProcess: Joi.string().max(255).allow(null, "").optional(),
  visaControleQualiteProcess: Joi.string().max(255).allow(null, "").optional(),
  visaProductionProcess: Joi.string().max(255).allow(null, "").optional(),
  dateValidationProcess: Joi.date().iso().allow(null, "").optional(),

  // ── Module N/C (parcours opérateur simplifié) — un seul statut par fiche.
  // Les 3 champs suivants ne sont pertinents que si conformite === "non_conforme"
  // (le front ne les envoie d'ailleurs que dans ce cas), mais on les valide
  // de façon permissive ici : c'est au front de décider quoi afficher/saisir.
  conformite: Joi.string().valid("conforme", "non_conforme").allow(null, "").empty("").optional(),
  descriptionNonConformite: Joi.string().max(5000).allow(null, "").optional(),
  photoNonConformite: Joi.string().max(500).allow(null, "").optional(),
  actionsCorrectives: Joi.string().max(5000).allow(null, "").optional(),

  // Lists (child tables)
  controlesQualite: Joi.array().items(controleQualiteSchema).optional(),
  arretsMachine: Joi.array().items(arretMachineSchema).optional(),
  consommations: Joi.array().items(consommationSchema).optional(),
  processControl: Joi.array().items(processControlSchema).optional(),
  nonConformites: Joi.array().items(nonConformiteSchema).optional(),
};

// Création d'un brouillon : validation souple — dateProduction/heureDebut/
// heureFin sont optionnels et acceptent `null` (l'opérateur les renseigne
// plus tard, avant la soumission finale).
const createSchema = Joi.object(baseFields);

const updateSchema = Joi.object(baseFields).min(1);

// Le front Flutter envoie le personnel sous forme imbriquée
// `personnelActif: { responsable1, responsable2, ... }`, mais ces champs
// sont des colonnes plates sur `por_promesh`. Sans cet aplatissement,
// `stripUnknown: true` supprime l'objet `personnelActif` en entier (clé
// inconnue du schéma) et tout le personnel est silencieusement perdu.
const PERSONNEL_KEYS = [
  "responsable1",
  "responsable2",
  "operateur1",
  "operateur2",
  "aideOperateur",
  "manoeuvre",
  "stagiaire1",
  "stagiaire2",
];

function flattenPersonnelActif(body) {
  if (!body || typeof body.personnelActif !== "object" || body.personnelActif === null) {
    return body;
  }
  const { personnelActif, ...rest } = body;
  const flat = { ...rest };
  for (const key of PERSONNEL_KEYS) {
    if (personnelActif[key] !== undefined) flat[key] = personnelActif[key];
  }
  return flat;
}

// Bouton "Nouvelle fiche" — body minimal (machine peut arriver en number ou
// string selon l'appelant).
const createOrOpenDraftSchema = Joi.object({
  machine: Joi.alternatives(Joi.string(), Joi.number()).required(),
  poste: Joi.string().valid("matin", "nuit").required(),
  operateurName: Joi.string().max(255).allow(null, "").optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(flattenPersonnelActif(req.body), {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.details.map((d) => d.message),
      });
    }
    req.body = value;
    next();
  };
}

module.exports = {
  validateCreate: validate(createSchema),
  validateUpdate: validate(updateSchema),
  validateCreateOrOpenDraft: validate(createOrOpenDraftSchema),
};
