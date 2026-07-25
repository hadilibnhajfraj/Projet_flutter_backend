"use strict";

const PDFDocument = require("pdfkit");
const { sequelize } = require("../../../db");
const repo = require("../repositories/porPromesh.repository");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
require("../../../models/associations");

// Mêmes rôles que READ_WRITE_ROLES (routes) — qui peut opérer ce module peut
// aussi apparaître dans la liste déroulante "Opérateur".
const OPERATOR_ROLES = ["admin", "superadmin", "superadmin2", "responsable_logistique_achat"];

// responsable_logistique_achat only ever sees/edits its own fiches —
// admin/superadmin see everything.
function isOwnerScoped(role) {
  return role === "responsable_logistique_achat";
}

function splitFields(body) {
  const { controlesQualite, arretsMachine, consommations, processControl, nonConformites, ...mainFields } = body;
  return {
    mainFields,
    children: { controlesQualite, arretsMachine, consommations, processControl, nonConformites },
  };
}

// Champs "heure" (colonnes Postgres TIME) qui ne doivent jamais recevoir
// une chaîne vide — Postgres lève "invalid input syntax for type time: """
// si on insère ''::time au lieu de NULL.
const TIME_FIELDS = [
  "heureDebut",
  "heureFin",
  "demarrageProductionHeure1",
  "demarrageProductionHeure2",
  "heureFinTravail",
];

function nullifyEmpty(value) {
  return value === "" ? null : value;
}

// Convertit toute heure vide ("") en `null` avant insertion/update en base.
function sanitizePayload(body) {
  const sanitized = { ...body };

  for (const key of TIME_FIELDS) {
    if (key in sanitized) sanitized[key] = nullifyEmpty(sanitized[key]);
  }

  return sanitized;
}

function assertOwnership(report, actor) {
  if (isOwnerScoped(actor.role) && report.createdBy !== actor.id) {
    throw { status: 403, message: "Vous ne pouvez accéder qu'à vos propres fiches PorPromesh" };
  }
}

// ── Génération automatique de "Paramètres du Poste" à partir de "Contrôle
// Machine" ────────────────────────────────────────────────────────────
//
// Les modules "Contrôle Process" et "Paramètres du Poste" ont été retirés
// de l'interface Flutter (plus aucune saisie manuelle) pour éliminer la
// double saisie avec "Contrôle Machine". Sur les 14 paramètres du tableau
// `por_promesh_process_control`, seuls 4 ont une correspondance réelle
// avec un champ de Contrôle Machine — les 10 autres (dimensions de
// plaque, diamètre de barre, etc.) mesurent des choses physiquement
// différentes et n'ont AUCUNE source de donnée : ils ne sont ni générés
// ni réécrits, leurs valeurs historiques (si une fiche plus ancienne en
// avait) restent telles quelles.
//
// Bloc unique "controle_08h20" : Contrôle Machine ne capture qu'un seul
// relevé par champ (pas 3 horaires distincts comme l'ancien Contrôle
// Process), donc un seul jeu de valeurs est généré, jamais 3.
const DERIVED_PROCESS_BLOC = "controle_08h20";

const DERIVED_PROCESS_PARAMS = [
  {
    // Même mesure, même unité (°C) que `temperatureEau` de Contrôle Machine.
    parametre: "Température d'eau",
    valeurP1: (r) => (r.temperatureEau == null ? null : String(r.temperatureEau)),
    // Même plage de conformité que Contrôle Machine (40-60°C — voir
    // PorPromeshController.machineTemperatureEauMin/Max côté Flutter).
    corP1: (r) => {
      if (r.temperatureEau == null) return false;
      const n = Number(r.temperatureEau);
      return !Number.isNaN(n) && n >= 40 && n <= 60;
    },
  },
  {
    // Correspondance exacte (OK/NOK) avec `etatDisqueCoupe`.
    parametre: "Etat disque de coupe",
    valeurP1: (r) => r.etatDisqueCoupe ?? null,
    corP1: (r) => r.etatDisqueCoupe === "OK",
  },
  {
    // Vocabulaire Contrôle Machine (Absence/Présence) → vocabulaire
    // Contrôle Process (Non/Oui) — traduction directe, même contrôle visuel.
    parametre: "Fuite d'eau",
    valeurP1: (r) => (r.fluideVisuel === "Absence" ? "Non" : r.fluideVisuel === "Présence" ? "Oui" : null),
    corP1: (r) => r.fluideVisuel === "Absence",
  },
  {
    // Copie du texte choisi côté Contrôle Machine ("< 6 bars" / "> 6 bars")
    // — `valeurP1` est une colonne texte (STRING(50)), aucune précision
    // numérique n'est inventée.
    parametre: "Pression d'air comprimé",
    valeurP1: (r) => r.air ?? null,
    corP1: (r) => r.air != null && r.air !== "< 6 bars",
  },
];

function buildDerivedProcessControlRows(machineFields) {
  const rows = DERIVED_PROCESS_PARAMS.map(({ parametre, valeurP1, corP1 }) => ({
    bloc: DERIVED_PROCESS_BLOC,
    parametre,
    valeurP1: valeurP1(machineFields),
    corP1: corP1(machineFields),
    valeurP2: null,
    corP2: false,
  }));

  // DIAGNOSTIC (voir demande "champs texte restent vides") — trace la
  // source (Contrôle Machine) et le résultat (lignes dérivées) à chaque
  // save, pour vérifier que valeurP1/corP1 sont bien remplis avant même
  // d'atteindre `replaceChildren`/la réponse API. À retirer une fois le
  // diagnostic terminé.
  console.log("[applyDerivedProcessControl] source Contrôle Machine =", {
    air: machineFields.air,
    niveauBainEau: machineFields.niveauBainEau,
    temperatureEau: machineFields.temperatureEau,
    temperaturePistons: machineFields.temperaturePistons,
    etatPistons: machineFields.etatPistons,
    fluideVisuel: machineFields.fluideVisuel,
    etatDisqueCoupe: machineFields.etatDisqueCoupe,
  });
  console.log(
    "[applyDerivedProcessControl] lignes dérivées =",
    rows.map((r) => `${r.parametre}: valeurP1=${JSON.stringify(r.valeurP1)} corP1=${r.corP1}`)
  );

  return rows;
}

// Fusionne les 4 lignes générées automatiquement dans `children.processControl`
// (in-place) sans jamais toucher aux 10 autres paramètres ni aux blocs
// 10h20/14h20 historiques. Si le client n'envoie pas lui-même de tableau
// `processControl` (plus aucun écran Flutter ne le remplit), on repart des
// lignes déjà en base pour ne rien perdre.
async function applyDerivedProcessControl(porPromeshId, machineFields, children, transaction) {
  const derivedRows = buildDerivedProcessControlRows(machineFields);
  const derivedKeys = new Set(derivedRows.map((r) => `${r.bloc}|${r.parametre}`));

  const baseRows = Array.isArray(children.processControl)
    ? children.processControl
    : await repo.findProcessControl(porPromeshId, transaction);

  const kept = baseRows
    .filter((r) => !derivedKeys.has(`${r.bloc}|${r.parametre}`))
    .map(({ bloc, parametre, valeurP1, corP1, valeurP2, corP2 }) => ({ bloc, parametre, valeurP1, corP1, valeurP2, corP2 }));

  children.processControl = [...kept, ...derivedRows];

  // DIAGNOSTIC — ce que `replaceChildren` va effectivement écrire en base
  // pour les 4 lignes dérivées (à retirer une fois le diagnostic terminé).
  console.log(
    "[applyDerivedProcessControl] merged into children.processControl =",
    children.processControl.filter((r) => derivedKeys.has(`${r.bloc}|${r.parametre}`))
  );
}

// Message renvoyé pour toute tentative de modification/suppression d'une
// fiche déjà verrouillée (validée définitivement via /validate).
const LOCKED_MESSAGE = "Cette fiche POR PROMESH est validée définitivement.";

async function createPorPromesh(body, actor) {
  const { mainFields, children } = splitFields(sanitizePayload(body));

  return sequelize.transaction(async (t) => {
    // status/isLocked/validatedAt ne sont jamais pilotés par le client —
    // ils prennent leurs valeurs par défaut en base (BROUILLON / false / null).
    const report = await repo.create({ ...mainFields, createdBy: actor.id }, t);
    // 1. Contrôle Machine déjà sauvegardé (ci-dessus) — 2/3. Paramètres du
    // Poste générés et fusionnés automatiquement à partir de ces mêmes
    // valeurs, puis persistés par `replaceChildren` juste en dessous.
    await applyDerivedProcessControl(report.id, report, children, t);
    await repo.replaceChildren(report.id, children, t);
    // 4. `findById` retourne un seul objet contenant à la fois les champs
    // Contrôle Machine (plats) et `processControl` (Paramètres du Poste).
    return repo.findById(report.id, t);
  });
}

// Filtres communs à listPorPromesh / getDashboard / getStats — le Dashboard
// du poste (machine + poste + date/dateRange + statut) pilote les 3 à
// l'identique pour rester cohérent (mêmes fiches comptées, listées et
// agrégées).
function buildWhere(actor, filters = {}) {
  const where = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  if (filters.machine) where.machine = filters.machine;
  if (filters.poste) where.poste = filters.poste;
  if (filters.date) {
    where.dateProduction = filters.date;
  } else if (filters.dateRange) {
    Object.assign(where, repo.dateRangeWhere(filters.dateRange));
  }
  switch (filters.status) {
    case "brouillon":
      where.status = "BROUILLON";
      break;
    case "valide":
      where.status = "VALIDE";
      break;
    case "conforme":
      where.conformite = "conforme";
      break;
    case "non_conforme":
      where.conformite = "non_conforme";
      break;
  }
  return where;
}

async function listPorPromesh(actor, filters = {}) {
  const where = buildWhere(actor, filters);
  if (filters.search) Object.assign(where, repo.searchClause(filters.search));

  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.max(1, parseInt(filters.pageSize, 10) || 1000);
  const light = filters.light === true || filters.light === "true";
  const [data, total] = await Promise.all([
    repo.findAll(where, { order: filters.sort, limit: pageSize, offset: (page - 1) * pageSize, light }),
    repo.count(where),
  ]);
  return { data, total };
}

// ── Bouton "Nouvelle fiche" : crée toujours une fiche neuve et indépendante,
// jamais de réutilisation d'un brouillon existant — aucune donnée d'une
// fiche précédente (même non validée) ne doit réapparaître.
async function createOrOpenDraft(actor, { machine, poste, operateurName }) {
  const machineStr = machine == null ? null : String(machine);
  const now = new Date();
  const dateProduction = now.toISOString().slice(0, 10);
  const heureDebut = now.toTimeString().slice(0, 8);
  // heureFin ne doit jamais être vide — par défaut = heureDebut (modifiable
  // par l'utilisateur avant validation).
  // Nom affiché de l'opérateur : la table users n'a pas de champ "nom", mais
  // user_profiles (1-1 avec users) en a un, rempli via PUT /users/me/profile
  // — c'est la vraie source du nom ("Najeh"), contrairement au contournement
  // précédent (nom envoyé par le frontend, dépendant du stockage local).
  // Repli sur operateurName (frontend) puis sur l'email si aucun profil.
  const requester = await User.findByPk(actor.id, { include: [{ model: UserProfile, as: "profile" }] });
  const operateur = requester?.profile?.name || (operateurName || "").trim() || actor.email;

  const created = await repo.create({
    machine: machineStr,
    poste,
    dateProduction,
    heureDebut,
    heureFin: heureDebut,
    operateur,
    createdBy: actor.id,
  });
  return repo.findById(created.id);
}

// ── Liste déroulante "Opérateur" — utilisateurs autorisés à opérer ce
// module (mêmes rôles que la création/modification de fiches), nom affiché
// résolu via user_profiles.
async function listOperators() {
  const users = await User.findAll({
    where: { role: OPERATOR_ROLES },
    include: [{ model: UserProfile, as: "profile", attributes: ["name"] }],
    attributes: ["id", "email"],
    order: [["email", "ASC"]],
  });
  return users.map((u) => ({ id: u.id, email: u.email, name: u.profile?.name || u.email }));
}

// ── Dashboard du poste (KPI) ────────────────────────────────────────────
async function getDashboard(actor, filters = {}) {
  const where = buildWhere(actor, filters);
  const rows = await repo.findForAggregates(where);

  const fichesValidees = rows.filter((r) => r.status === "VALIDE").length;
  const fichesBrouillon = rows.filter((r) => r.status === "BROUILLON").length;
  const nonConformites = rows.filter((r) => r.conformite === "non_conforme").length;
  const productionTotale = rows.reduce((sum, r) => sum + (Number(r.productionM2) || 0), 0);
  const operateursPresents = new Set(
    rows.map((r) => (r.operateur || "").trim()).filter((v) => v.length > 0)
  ).size;

  return {
    fichesCount: rows.length,
    fichesValidees,
    fichesBrouillon,
    productionTotale,
    nonConformites,
    operateursPresents,
  };
}

// ── Statistiques / graphiques du poste ───────────────────────────────────
async function getStats(actor, filters = {}) {
  const where = buildWhere(actor, filters);
  const rows = await repo.findForAggregates(where);

  const parHeure = Array.from({ length: 24 }, (_, hour) => ({ hour, production: 0 }));
  let conforme = 0;
  let nonConforme = 0;
  for (const r of rows) {
    const created = r.createdAt ? new Date(r.createdAt) : null;
    if (created) parHeure[created.getHours()].production += Number(r.productionM2) || 0;
    if (r.conformite === "conforme") conforme += 1;
    if (r.conformite === "non_conforme") nonConforme += 1;
  }

  // "Production des 7 derniers jours" : toujours une fenêtre calendaire de 7
  // jours pour la/les machine(s)/poste filtrés, indépendamment du filtre
  // date/dateRange actif (sinon "Aujourd'hui" réduirait la courbe à 1 point).
  const trendWhere = { ...where };
  delete trendWhere.dateProduction;
  delete trendWhere.createdAt;
  const trendRows = await repo.findForAggregates(trendWhere);

  const today = new Date();
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (6 - i));
    return { date: dayKey(d), production: 0 };
  });
  const byDay = new Map(last7.map((b) => [b.date, b]));
  for (const r of trendRows) {
    if (!r.createdAt) continue;
    const key = dayKey(new Date(r.createdAt));
    const bucket = byDay.get(key);
    if (bucket) bucket.production += Number(r.productionM2) || 0;
  }

  return {
    parHeure,
    conformite: { conforme, nonConforme },
    parJour: last7,
  };
}

async function getPorPromeshById(id, actor) {
  const report = await repo.findById(id);
  if (!report) throw { status: 404, message: "PorPromesh introuvable" };
  assertOwnership(report, actor);
  return report;
}

async function updatePorPromesh(id, body, actor) {
  const { mainFields, children } = splitFields(sanitizePayload(body));

  return sequelize.transaction(async (t) => {
    const report = await repo.findBareById(id, t);
    if (!report) throw { status: 404, message: "PorPromesh introuvable" };
    assertOwnership(report, actor);

    if (report.isLocked) {
      throw { status: 403, message: LOCKED_MESSAGE };
    }

    if (Object.keys(mainFields).length) {
      await repo.update(report, mainFields, t);
    }

    // 1. Contrôle Machine déjà sauvegardé (ci-dessus, `report` reflète les
    // valeurs à jour même si cette requête n'en a modifié qu'une partie —
    // `findBareById` avait déjà chargé les colonnes existantes). 2/3.
    // Paramètres du Poste régénérés à partir de ces valeurs à chaque
    // enregistrement (synchronisation automatique, aucune intervention
    // manuelle), fusionnés sans toucher aux 10 paramètres non dérivables.
    await applyDerivedProcessControl(id, report, children, t);
    await repo.replaceChildren(id, children, t);

    // 4. Un seul objet retourné, contenant Contrôle Machine (champs plats)
    // et Paramètres du Poste (`processControl`) à jour.
    return repo.findById(id, t);
  });
}

async function deletePorPromesh(id, actor) {
  const report = await repo.findBareById(id);
  if (!report) throw { status: 404, message: "PorPromesh introuvable" };
  assertOwnership(report, actor);

  if (report.isLocked) {
    throw { status: 403, message: LOCKED_MESSAGE };
  }

  await repo.destroy(report);
  return { id };
}

// Champs devenant obligatoires uniquement à la soumission finale ("Terminer
// la saisie") — validation souple au brouillon, stricte à la validation.
const REQUIRED_ON_VALIDATE = [
  ["dateProduction", "Date de production"],
  ["heureDebut", "Heure début"],
  ["heureFin", "Heure fin"],
];

function isBlank(value) {
  return value === null || value === undefined || value === "";
}

// Verrouillage définitif : BROUILLON → VALIDE. Idempotent dans l'intention
// mais refusé si déjà verrouillée (mêmes garde-fous qu'update/delete) —
// évite d'écraser un validatedAt déjà posé.
async function validatePorPromesh(id, actor) {
  const report = await repo.findBareById(id);
  if (!report) throw { status: 404, message: "PorPromesh introuvable" };
  assertOwnership(report, actor);

  if (report.isLocked) {
    throw { status: 403, message: LOCKED_MESSAGE };
  }

  const missing = REQUIRED_ON_VALIDATE.filter(([field]) => isBlank(report[field])).map(([, label]) => label);
  if (missing.length) {
    throw {
      status: 400,
      message: `Impossible de terminer la saisie : champ(s) manquant(s) — ${missing.join(", ")}.`,
    };
  }

  await repo.update(report, { status: "VALIDE", isLocked: true, validatedAt: new Date() });
  return repo.findById(id);
}

async function addAttachment(id, actor, file) {
  const report = await repo.findBareById(id);
  if (!report) throw { status: 404, message: "PorPromesh introuvable" };
  assertOwnership(report, actor);

  return repo.createAttachment({
    porPromeshId: id,
    uploadedBy: actor.id,
    fileName: file.originalname,
    fileUrl: `/uploads/porpromesh/${file.filename}`,
  });
}

// ── PDF export ──────────────────────────────────────────────

function row(doc, label, value) {
  doc.font("Helvetica-Bold").text(`${label}: `, { continued: true }).font("Helvetica").text(value ?? "-");
}

function sectionTitle(doc, title) {
  doc.moveDown(0.5).font("Helvetica-Bold").fontSize(13).text(title).fontSize(10).moveDown(0.3);
}

function buildPorPromeshPdf(report) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });

  doc.fontSize(16).font("Helvetica-Bold").text("Fiche POR PROMESH", { align: "center" });
  doc.fontSize(10).font("Helvetica").text(`ID : ${report.id}`, { align: "center" });
  doc.moveDown();

  sectionTitle(doc, "Rapport Journalier de Production");
  row(doc, "Date de production", report.dateProduction);
  row(doc, "Heure début / fin", `${report.heureDebut} - ${report.heureFin}`);
  row(doc, "Diamètre maille (1 / 2 / 3)", `${report.diametreMaille1 ?? "-"} / ${report.diametreMaille2 ?? "-"} / ${report.diametreMaille3 ?? "-"}`);
  row(doc, "Production", report.productionM2 != null ? `${report.productionM2} m²` : null);
  row(doc, "Démarrage production 1 (heure / quantité)", `${report.demarrageProductionHeure1 ?? "-"} / ${report.demarrageProductionQuantite1 ?? "-"}`);
  row(doc, "Démarrage production 2 (heure / quantité)", `${report.demarrageProductionHeure2 ?? "-"} / ${report.demarrageProductionQuantite2 ?? "-"}`);

  sectionTitle(doc, "Personnel");
  row(doc, "Responsables", `${report.responsable1 ?? "-"} / ${report.responsable2 ?? "-"}`);
  row(doc, "Opérateurs", `${report.operateur1 ?? "-"} / ${report.operateur2 ?? "-"}`);
  row(doc, "Aide opérateur", report.aideOperateur);
  row(doc, "Manœuvre", report.manoeuvre);
  row(doc, "Stagiaires", `${report.stagiaire1 ?? "-"} / ${report.stagiaire2 ?? "-"}`);
  row(doc, "Observation personnel", report.observationPersonnel);

  sectionTitle(doc, "Contrôles qualité");
  (report.controlesQualite || []).forEach((c) => {
    doc.text(`• ${c.heure ?? "-"} | plaque ${c.numeroPlaque ?? "-"} | maille ${c.maille ?? "-"} | L ${c.longueur ?? "-"} x l ${c.largeur ?? "-"} | statut: ${c.statutCOQ ?? "-"}`);
  });

  sectionTitle(doc, "Arrêts machine");
  (report.arretsMachine || []).forEach((a) => {
    doc.text(`• ${a.tArret ?? "-"} ${a.observationMachine ? "| " + a.observationMachine : ""}`);
  });

  sectionTitle(doc, "Consommations");
  (report.consommations || []).forEach((c) => {
    doc.text(`• ${c.designationArticle ?? "-"} : ${c.metrage ?? "-"} m ${c.observation ? "| " + c.observation : ""}`);
  });

  sectionTitle(doc, "Fin de travail");
  row(doc, "Heure fin de travail", report.heureFinTravail);
  row(doc, "Observation fin de travail", report.observationFinTravail);
  row(doc, "Total main d'œuvre", report.totalMainOeuvre);
  row(doc, "Total chute barres", report.totalChuteBarres);
  row(doc, "Total déchet graine", report.totalDechetGraine);

  sectionTitle(doc, "Visas");
  row(doc, "Visa production", report.visaProduction);
  row(doc, "Visa contrôle qualité", report.visaControleQualite);
  row(doc, "Visa direction", report.visaDirection);

  sectionTitle(doc, "Plan de Process PROMESH");
  row(doc, "Air", report.air);
  row(doc, "Niveau bain d'eau", report.niveauBainEau);
  row(doc, "Température eau / pistons", `${report.temperatureEau ?? "-"} / ${report.temperaturePistons ?? "-"}`);
  row(doc, "État pistons", report.etatPistons);
  row(doc, "Fluide visuel", report.fluideVisuel);
  row(doc, "État disque de coupe", report.etatDisqueCoupe);

  sectionTitle(doc, "Contrôle Process PROMESH");
  (report.processControl || []).forEach((p) => {
    const cor1 = p.corP1 ? "OK" : "-";
    const cor2 = p.corP2 ? "OK" : "-";
    doc.text(`• [${p.bloc ?? "-"}] ${p.parametre ?? "-"} : P1=${p.valeurP1 ?? "-"} (${cor1}) | P2=${p.valeurP2 ?? "-"} (${cor2})`);
  });
  row(doc, "Observations générales", report.observationsGenerales);

  sectionTitle(doc, "Validation");
  row(doc, "Visa responsable logistique", report.visaResponsableLogistiqueProcess);
  row(doc, "Visa contrôle qualité (process)", report.visaControleQualiteProcess);
  row(doc, "Visa production (process)", report.visaProductionProcess);
  row(doc, "Date validation", report.dateValidationProcess);

  if (report.attachments?.length) {
    sectionTitle(doc, "Pièces jointes");
    report.attachments.forEach((a) => doc.text(`• ${a.fileName}`));
  }

  doc.end();
  return doc;
}

async function getPorPromeshPdf(id, actor) {
  const report = await getPorPromeshById(id, actor);
  return buildPorPromeshPdf(report.toJSON ? report.toJSON() : report);
}

module.exports = {
  createPorPromesh,
  createOrOpenDraft,
  listOperators,
  listPorPromesh,
  getDashboard,
  getStats,
  getPorPromeshById,
  updatePorPromesh,
  deletePorPromesh,
  validatePorPromesh,
  addAttachment,
  getPorPromeshPdf,
};
