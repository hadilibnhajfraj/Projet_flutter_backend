"use strict";

// Validation des nouvelles fiches de production (PROMESH / PROBAR) créées par
// les comptes de production (config/productionFicheApproval.js) : statut
// « En attente de validation » dès la création, puis « Validée » ou
// « Refusée » sur décision explicite du responsable logistique. Après un
// refus, le créateur corrige sa fiche puis la soumet de nouveau (nouvelle
// soumission numérotée, l'ancienne décision reste dans l'historique).
//
// Indépendant du cycle de saisie existant (BROUILLON / VALIDE, enregistree /
// validee), qui n'est jamais modifié ici.

const { Op } = require("sequelize");
const { sequelize } = require("../../../db");
const cfg = require("../../../config/productionFicheApproval");
const PorPromesh = require("../../../models/PorPromesh");
const IndustrialRecord = require("../../../models/IndustrialRecord");
const History = require("../../../models/ProductionFicheApprovalHistory");
const notify = require("./ficheApprovalNotify.service");
const User = require("../../../models/User");
const logger = require("../../../utils/logger");
const { toApprovalBlock } = require("./approvalBlock");
require("../../../models/associations");

const { STATUSES, STATUS_LABELS } = cfg;
const COMMENT_MAX = 2000;

class FicheApprovalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  toJSON() {
    return { success: false, code: this.code, message: this.message };
  }
}

// ── Création d'une fiche : statut initial ────────────────────────────────

// Champs à poser dans l'INSERT même de la fiche (aucune fiche d'un compte de
// production ne peut exister sans statut de validation). {} pour les autres
// comptes : leurs fiches restent hors circuit, comme avant.
function initialFields(actor, now = new Date()) {
  if (!cfg.isCreator(actor?.email)) return {};
  return { approvalStatus: STATUSES.PENDING, approvalVersion: 1, approvalSubmittedAt: now };
}

// Première ligne d'historique (soumission n° 1). Dans la transaction de la
// création quand il y en a une.
async function recordCreation(ficheType, fiche, actor, { transaction } = {}) {
  if (!fiche?.approvalStatus) return;
  await History.create(
    {
      ficheType,
      ficheId: fiche.id,
      version: fiche.approvalVersion || 1,
      fromStatus: null,
      toStatus: STATUSES.PENDING,
      changedBy: actor.id,
      changedByEmail: actor.email,
      comment: "Fiche créée — en attente de validation par le responsable logistique.",
    },
    { transaction }
  );
}

// Après l'enregistrement d'une fiche d'un compte de production : notifie le
// responsable logistique (notification + email interne, sans doublon). Jamais
// bloquant : un échec est journalisé, la fiche reste créée et en attente.
async function notifyCreated(ficheType, fiche) {
  if (!fiche?.approvalStatus) return;
  try {
    const full = await loadFiche(ficheType, fiche.id);
    const item = toItem(ficheType, full);
    await notify.notifyPending(item);
    await notify.broadcastUpdated(item);
  } catch (e) {
    logger.error(`[FICHE-APPROVAL] notification de création ${ficheType}/${fiche.id}: ${e.message}`);
  }
}

// Fiche PROMESH verrouillée (« Terminer la saisie ») mais refusée : son
// créateur peut la corriger avant de la soumettre de nouveau.
function canCorrect(fiche, actor) {
  return fiche?.approvalStatus === STATUSES.REJECTED && fiche.createdBy === actor?.id && cfg.isCreator(actor?.email);
}

// ── Accès aux deux tables de fiches ──────────────────────────────────────

const TYPES = {
  promesh: { model: PorPromesh, label: "PROMESH", baseWhere: {} },
  probar: { model: IndustrialRecord, label: "PROBAR", baseWhere: { module: "probar" } },
};

function typeDef(ficheType) {
  const def = TYPES[String(ficheType || "").toLowerCase()];
  if (!def) throw new FicheApprovalError(404, "UNKNOWN_FICHE_TYPE", "Type de fiche inconnu.");
  return def;
}

const CREATOR_INCLUDE = [{ model: User, as: "creator", attributes: ["id", "email"] }];

async function loadFiche(ficheType, id, { transaction, include = CREATOR_INCLUDE } = {}) {
  const def = typeDef(ficheType);
  const fiche = await def.model.findOne({ where: { id, ...def.baseWhere }, include, transaction });
  if (!fiche || !fiche.approvalStatus) throw new FicheApprovalError(404, "FICHE_NOT_FOUND", "Fiche introuvable dans le circuit de validation.");
  return fiche;
}

function numeroOf(ficheType, r) {
  if (ficheType === "promesh") {
    if (r.sequenceNumber == null) return null;
    const year = r.createdAt ? new Date(r.createdAt).getFullYear() : new Date().getFullYear();
    return `PROMESH-${year}-${String(r.sequenceNumber).padStart(6, "0")}`;
  }
  return `PROBAR-${String(r.id).slice(0, 8).toUpperCase()}`;
}

const POSTE_LABELS = { matin: "Matin", nuit: "Soir" };

const SAISIE_LABELS = {
  promesh: { BROUILLON: "Saisie en cours", VALIDE: "Saisie terminée", ARCHIVED: "Archivée" },
  probar: { enregistree: "Saisie en cours", brouillon: "Saisie en cours", validee: "Saisie terminée", archivee: "Archivée" },
};

const num = (v) => (v == null || v === "" ? null : Number(v));

function parseProbarBlob(r) {
  try {
    const d = JSON.parse(r.description || "{}");
    return d && typeof d === "object" ? d : {};
  } catch (_) {
    return {};
  }
}

// Résumé d'une fiche pour la liste du responsable et des créateurs.
function toItem(ficheType, fiche) {
  const r = fiche.toJSON ? fiche.toJSON() : fiche;
  const isPromesh = ficheType === "promesh";
  const saisie = isPromesh ? r.status : r.statut;
  const blob = isPromesh ? null : parseProbarBlob(r);
  return {
    ficheType,
    ficheTypeLabel: TYPES[ficheType].label,
    id: r.id,
    numero: numeroOf(ficheType, r),
    status: r.approvalStatus,
    statusLabel: STATUS_LABELS[r.approvalStatus] || r.approvalStatus,
    version: r.approvalVersion,
    submittedAt: r.approvalSubmittedAt,
    decidedAt: r.approvalDecidedAt,
    decidedByEmail: r.approvalDecidedByEmail,
    rejectedAt: r.approvalRejectedAt,
    rejectionComment: r.approvalRejectionComment,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    createdBy: r.createdBy,
    creatorEmail: r.creator?.email || null,
    machine: r.machine,
    poste: r.poste,
    posteLabel: POSTE_LABELS[r.poste] || r.poste || null,
    dateProduction: isPromesh ? r.dateProduction : r.dateFiche,
    operateur: r.operateur,
    saisieStatus: saisie,
    saisieLabel: SAISIE_LABELS[ficheType][saisie] || saisie,
    // Quantités principales (détail complet : getDetail).
    production: isPromesh
      ? { value: num(r.productionM2), unit: "m²", label: "Production" }
      : { value: num(r.quantiteProduite), unit: null, label: "Rendement (production)" },
    dechets: isPromesh
      ? [
          { label: "Total chute barres", value: num(r.totalChuteBarres) },
          { label: "Total déchet graine", value: num(r.totalDechetGraine) },
        ]
      : (Array.isArray(blob.cq) ? blob.cq : [])
          .filter((c) => c && String(c.longueurDechet ?? "").trim() !== "")
          .map((c) => ({ label: `Longueur déchet (${c.heure || "—"})`, value: num(String(c.longueurDechet).replace(",", ".")) })),
  };
}

// ── Détails complets (sections lisibles, uniquement les valeurs saisies) ─

const filled = (v) => v !== undefined && v !== null && String(v).trim() !== "";
function section(title, pairs) {
  const rows = pairs.filter(([, v]) => filled(v)).map(([label, v]) => ({ label, value: String(v) }));
  return rows.length ? { title, rows } : null;
}
function table(title, columns, rows) {
  const kept = rows
    .map((row) => columns.map(([key]) => (filled(row?.[key]) ? String(row[key]) : "")))
    .filter((cells) => cells.some((c) => c !== ""));
  return kept.length ? { title, columns: columns.map(([, label]) => label), rows: kept } : null;
}
const time = (v) => (v ? String(v).slice(0, 5) : null);
const CONFORMITE = { conforme: "Conforme", non_conforme: "Non conforme", ok: "OK", nok: "NOK" };

function promeshDetails(r) {
  return {
    sections: [
      section("Informations générales", [
        ["Date de production", r.dateProduction],
        ["Heure début", time(r.heureDebut)],
        ["Heure fin", time(r.heureFin)],
        ["Machine", r.machine],
        ["Poste", POSTE_LABELS[r.poste] || r.poste],
        ["Opérateur", r.operateur],
        ["Lot", r.lot],
        ["Ordre de fabrication", r.ordreFabrication],
      ]),
      section("Dimensions", [
        ["Diamètre maille 1", r.diametreMaille1],
        ["Diamètre maille 2", r.diametreMaille2],
        ["Diamètre maille 3", r.diametreMaille3],
      ]),
      section("Quantités produites", [
        ["Production (m²)", r.productionM2],
        ["Démarrage production 1 — heure", time(r.demarrageProductionHeure1)],
        ["Démarrage production 1 — quantité", r.demarrageProductionQuantite1],
        ["Démarrage production 2 — heure", time(r.demarrageProductionHeure2)],
        ["Démarrage production 2 — quantité", r.demarrageProductionQuantite2],
      ]),
      section("Déchets", [
        ["Total chute barres", r.totalChuteBarres],
        ["Total déchet graine", r.totalDechetGraine],
        ["Total main d'œuvre", r.totalMainOeuvre],
      ]),
      section("Personnel", [
        ["Responsable 1", r.responsable1],
        ["Responsable 2", r.responsable2],
        ["Opérateur 1", r.operateur1],
        ["Opérateur 2", r.operateur2],
        ["Aide opérateur", r.aideOperateur],
        ["Manœuvre", r.manoeuvre],
        ["Stagiaire 1", r.stagiaire1],
        ["Stagiaire 2", r.stagiaire2],
        ["Observation personnel", r.observationPersonnel],
      ]),
      section("Contrôle machine", [
        ["Pression d'air", r.air],
        ["Niveau bain d'eau", r.niveauBainEau],
        ["Température pistons", r.temperaturePistons],
        ["État pistons", r.etatPistons],
        ["Fluide visuel", r.fluideVisuel],
        ["Justification contrôle machine", r.justificationControleMachine],
      ]),
      section("Conformité", [
        ["Conformité", CONFORMITE[r.conformite] || r.conformite],
        ["Description non-conformité", r.descriptionNonConformite],
        ["Actions correctives", r.actionsCorrectives],
      ]),
      section("Observations", [
        ["Observations générales", r.observationsGenerales],
        ["Heure fin de travail", time(r.heureFinTravail)],
        ["Observation fin de travail", r.observationFinTravail],
      ]),
    ].filter(Boolean),
    tables: [
      table(
        "Contrôle qualité",
        [["heure", "Heure"], ["numeroPlaque", "N° plaque"], ["maille", "Maille"], ["longueur", "Longueur"], ["largeur", "Largeur"], ["statutCOQ", "Statut"]],
        r.controlesQualite || []
      ),
      table("Arrêts machine", [["tArret", "Durée d'arrêt"], ["observationMachine", "Observation"]], r.arretsMachine || []),
      table("Consommations", [["designationArticle", "Article"], ["metrage", "Métrage"], ["observation", "Observation"]], r.consommations || []),
    ].filter(Boolean),
  };
}

const PROBAR_PERSONNEL = [["r1", "Responsable 1"], ["r2", "Responsable 2"], ["o1", "Opérateur 1"], ["o2", "Opérateur 2"], ["ao", "Aide opérateur"], ["mn", "Manœuvre"], ["s1", "Stagiaire 1"], ["s2", "Stagiaire 2"]];
const PROBAR_MACHINE = [
  ["ai", "Pression d'air"], ["nb", "Niveau bain d'eau"], ["te", "Température eau"], ["td", "Température demandée"],
  ["ep", "État pistons"], ["fv", "Fluide visuel"], ["ed", "État disque de coupe"], ["bo", "Bobine"], ["rs", "Résistance"],
  ["fo", "Four"], ["z1", "Four zone 1"], ["z2", "Four zone 2"], ["z3", "Four zone 3"], ["nbb", "Nombre de bobines"],
  ["bf", "Bain d'eau filtré"], ["mc", "Machine ceinture"], ["mb", "Machine bobinage"], ["jm", "Justification contrôle machine"],
];

function probarDetails(r) {
  const d = parseProbarBlob(r);
  const p = d.p || {};
  const cm = d.cm || {};
  const qm = d.qm || {};
  const lignes = [1, 2, 3, 4].map((i) => ({
    ligne: `L${i}`,
    h: qm[`l${i}h`], l: qm[`l${i}l`], m: qm[`l${i}m`], d: qm[`l${i}d`],
  }));
  return {
    sections: [
      section("Informations générales", [
        ["Date de la fiche", r.dateFiche],
        ["Heure début", d.hd],
        ["Heure fin", d.hf],
        ["Machine", r.machine],
        ["Poste", POSTE_LABELS[r.poste] || r.poste],
        ["Opérateur", r.operateur],
        ["Lot", r.lot],
        ["Ordre de fabrication", r.ordreFabrication],
      ]),
      section("Dimensions", [["Diamètre", d.dia], ["Température (mesures qualité)", qm.tp]]),
      section("Quantités produites", [
        ["Rendement (production)", r.quantiteProduite],
        ["Statut qualité", CONFORMITE[r.statutQualite] || r.statutQualite],
      ]),
      section("Personnel", PROBAR_PERSONNEL.map(([k, label]) => [label, p[k]])),
      section("Contrôle machine", PROBAR_MACHINE.map(([k, label]) => [label, cm[k]])),
      section("Non-conformité", [["Description", d.dnc], ["Actions correctives", d.ac]]),
      section("Observations", [["Observations", r.observations], ["Justification contrôle process", d.jp]]),
    ].filter(Boolean),
    tables: [
      table("Mesures qualité (dimensions)", [["ligne", "Ligne"], ["h", "Hauteur"], ["l", "Largeur"], ["m", "Maille"], ["d", "Diamètre"]],
        lignes.filter((x) => [x.h, x.l, x.m, x.d].some(filled))),
      table(
        "Contrôle qualité (production et déchets)",
        [["heure", "Heure"], ["nbBobines", "Nb bobines"], ["vitesse", "Vitesse"], ["mesure", "Mesure"], ["diametre", "Diamètre"], ["poids", "Poids"], ["longueurBarre", "Longueur barre"], ["longueurDechet", "Longueur déchet"], ["statutCOQ", "Statut"]],
        // Créneaux horaires prédéfinis : seuls ceux qui ont des mesures.
        (Array.isArray(d.cq) ? d.cq : []).filter((c) =>
          ["nbBobines", "vitesse", "mesure", "diametre", "poids", "longueurBarre", "longueurDechet", "statutCOQ"].some((k) => filled(c?.[k]))
        )
      ),
    ].filter(Boolean),
  };
}

// ── Permissions ──────────────────────────────────────────────────────────

function permissionsFor(user) {
  const actor = actorOf(user);
  return {
    canView: cfg.canViewAll(actor) || cfg.isCreator(actor.email),
    canViewAll: cfg.canViewAll(actor),
    canDecide: cfg.isValidator(actor.email),
    isCreator: cfg.isCreator(actor.email),
    // Filtre « Producteur » de l'historique (comptes soumis à validation).
    creators: cfg.canViewAll(actor) ? cfg.creators : [actor.email],
  };
}

function actorOf(user) {
  return { id: user.sub || user.id, email: String(user.email || "").toLowerCase().trim(), role: user.role };
}

function assertCanView(actor) {
  if (!cfg.canViewAll(actor) && !cfg.isCreator(actor.email)) {
    throw new FicheApprovalError(403, "FORBIDDEN", "Accès réservé au responsable logistique et aux comptes de production concernés.");
  }
}

function scopeWhere(actor) {
  return cfg.canViewAll(actor) ? {} : { createdBy: actor.id };
}

function assertCanSee(actor, fiche) {
  if (!cfg.canViewAll(actor) && fiche.createdBy !== actor.id) {
    throw new FicheApprovalError(403, "NOT_OWNER", "Vous ne pouvez consulter que vos propres fiches.");
  }
}

// ── Liste, compteurs, détail ─────────────────────────────────────────────

const LIST_ATTRIBUTES = {
  promesh: { exclude: [] },
  probar: { exclude: ["melangeData"] },
};

// Fiches visibles par l'acteur correspondant aux filtres (sans pagination) —
// partagé par la liste et les compteurs, qui appliquent donc exactement les
// mêmes filtres.
async function collectItems(actor, filters = {}) {
  const where = { ...scopeWhere(actor) };
  if (filters.status && filters.status !== "all") where.approvalStatus = filters.status;
  else where.approvalStatus = { [Op.ne]: null };

  const types = filters.type ? [filters.type] : cfg.FICHE_TYPES;
  const chunks = await Promise.all(
    types.map(async (t) => {
      const def = typeDef(t);
      const typeWhere = { ...where, ...def.baseWhere };
      if (filters.poste) typeWhere.poste = filters.poste;
      if (filters.machine) typeWhere.machine = String(filters.machine);
      // Période : date de production de la fiche (bornes incluses).
      if (filters.from || filters.to) {
        typeWhere[t === "promesh" ? "dateProduction" : "dateFiche"] = {
          ...(filters.from ? { [Op.gte]: filters.from } : {}),
          ...(filters.to ? { [Op.lte]: filters.to } : {}),
        };
      }
      const rows = await def.model.findAll({ where: typeWhere, attributes: LIST_ATTRIBUTES[t], include: CREATOR_INCLUDE });
      return rows.map((r) => toItem(t, r));
    })
  );
  let items = chunks.flat();
  if (filters.creator) items = items.filter((i) => i.creatorEmail === String(filters.creator).toLowerCase());
  if (filters.search) {
    const q = String(filters.search).toLowerCase().trim();
    // Numéro de fiche, producteur, validateur (et machine / opérateur / date).
    items = items.filter((i) =>
      [i.numero, i.creatorEmail, i.decidedByEmail, i.machine, i.operateur, i.dateProduction].some((v) => String(v ?? "").toLowerCase().includes(q))
    );
  }
  return items;
}

async function listFiches(user, filters = {}) {
  const actor = actorOf(user);
  assertCanView(actor);
  const items = await collectItems(actor, filters);
  // En attente : la plus ancienne soumission d'abord ; sinon la plus récente.
  const asc = filters.status === STATUSES.PENDING;
  items.sort((a, b) => {
    const d = new Date(a.submittedAt || a.createdAt) - new Date(b.submittedAt || b.createdAt);
    return asc ? d : -d;
  });

  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(500, parseInt(filters.pageSize, 10) || 100));
  return { data: items.slice((page - 1) * pageSize, page * pageSize), total: items.length };
}

const SUMMARY_FILTERS = ["from", "to", "type", "machine", "poste", "creator", "search"];

// Compteurs (en attente, acceptées, refusées, traitées = acceptées +
// refusées). Avec des filtres (période, type, machine, poste, producteur,
// recherche — jamais le statut), mêmes fiches que la liste ; sans filtre,
// simple comptage en base (badge du menu, interrogé régulièrement).
async function summary(user, filters = {}) {
  const actor = actorOf(user);
  assertCanView(actor);
  const applied = Object.fromEntries(SUMMARY_FILTERS.filter((k) => filters[k]).map((k) => [k, filters[k]]));
  if (Object.keys(applied).length) {
    const items = await collectItems(actor, { ...applied, status: "all" });
    const n = (s) => items.filter((i) => i.status === s).length;
    const approved = n(STATUSES.APPROVED);
    const rejected = n(STATUSES.REJECTED);
    return { pending: n(STATUSES.PENDING), approved, rejected, processed: approved + rejected };
  }
  const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const t of cfg.FICHE_TYPES) {
    const def = typeDef(t);
    const rows = await def.model.findAll({
      where: { ...scopeWhere(actor), ...def.baseWhere, approvalStatus: { [Op.ne]: null } },
      attributes: ["approvalStatus", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
      group: ["approvalStatus"],
      raw: true,
    });
    for (const r of rows) counts[r.approvalStatus] = (counts[r.approvalStatus] || 0) + Number(r.n);
  }
  return { pending: counts.PENDING, approved: counts.APPROVED, rejected: counts.REJECTED, processed: counts.APPROVED + counts.REJECTED };
}

async function historyOf(ficheType, ficheId, transaction) {
  const rows = await History.findAll({ where: { ficheType, ficheId }, order: [["createdAt", "ASC"]], transaction });
  return rows.map((h) => ({
    version: h.version,
    fromStatus: h.fromStatus,
    toStatus: h.toStatus,
    toStatusLabel: STATUS_LABELS[h.toStatus] || h.toStatus,
    changedByEmail: h.changedByEmail,
    comment: h.comment,
    createdAt: h.createdAt,
  }));
}

const PROMESH_DETAIL_INCLUDE = () => {
  const children = ["controlesQualite", "arretsMachine", "consommations"];
  return [...CREATOR_INCLUDE, ...children.map((as) => ({ association: as }))];
};

async function getDetail(user, ficheType, id) {
  const actor = actorOf(user);
  assertCanView(actor);
  const type = String(ficheType).toLowerCase();
  const fiche = await loadFiche(type, id, { include: type === "promesh" ? PROMESH_DETAIL_INCLUDE() : CREATOR_INCLUDE });
  assertCanSee(actor, fiche);
  const r = fiche.toJSON();
  return {
    ...toItem(type, fiche),
    details: type === "promesh" ? promeshDetails(r) : probarDetails(r),
    history: await historyOf(type, id),
    canDecide: cfg.isValidator(actor.email) && r.approvalStatus === STATUSES.PENDING && r.createdBy !== actor.id,
    canResubmit: canCorrect(r, actor),
  };
}

// ── Décisions ────────────────────────────────────────────────────────────

function sameInstant(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

// Une décision porte sur la soumission (version) et le contenu (updatedAt)
// affichés au responsable : si la fiche a été soumise de nouveau ou modifiée
// entre-temps, la décision est refusée (aucune décision contradictoire).
function assertDecidable(actor, fiche, { version, ficheUpdatedAt }) {
  if (!cfg.isValidator(actor.email)) {
    throw new FicheApprovalError(403, "NOT_VALIDATOR", "Seul le responsable logistique peut valider ou refuser une fiche de production.");
  }
  if (fiche.createdBy === actor.id) {
    throw new FicheApprovalError(403, "OWN_FICHE", "Vous ne pouvez pas valider votre propre fiche.");
  }
  if (fiche.approvalStatus !== STATUSES.PENDING) {
    throw new FicheApprovalError(409, "ALREADY_DECIDED", `Cette fiche a déjà été traitée (statut : ${STATUS_LABELS[fiche.approvalStatus] || fiche.approvalStatus}).`);
  }
  if (version != null && Number(version) !== fiche.approvalVersion) {
    throw new FicheApprovalError(409, "VERSION_MISMATCH", "Cette fiche a été soumise de nouveau entre-temps. Actualisez la liste avant de décider.");
  }
  if (ficheUpdatedAt && !sameInstant(ficheUpdatedAt, fiche.updatedAt)) {
    throw new FicheApprovalError(409, "FICHE_MODIFIED", "Cette fiche a été modifiée depuis son affichage. Actualisez la liste avant de décider.");
  }
}

async function decide(user, ficheType, id, body, toStatus) {
  const actor = actorOf(user);
  const type = String(ficheType).toLowerCase();
  const def = typeDef(type);
  const comment = String(body.comment ?? "").trim();
  if (toStatus === STATUSES.REJECTED && !comment) {
    throw new FicheApprovalError(400, "REJECTION_COMMENT_REQUIRED", "Le motif du refus est obligatoire.");
  }
  if (comment.length > COMMENT_MAX) {
    throw new FicheApprovalError(400, "COMMENT_TOO_LONG", `Le motif ne doit pas dépasser ${COMMENT_MAX} caractères.`);
  }

  const result = await sequelize.transaction(async (transaction) => {
    const fiche = await loadFiche(type, id, { transaction });
    assertDecidable(actor, fiche, body);

    const now = new Date();
    const patch = {
      approvalStatus: toStatus,
      approvalDecidedAt: now,
      approvalDecidedBy: actor.id,
      approvalDecidedByEmail: actor.email,
      ...(toStatus === STATUSES.REJECTED ? { approvalRejectedAt: now, approvalRejectionComment: comment } : {}),
    };
    // Mise à jour conditionnelle : deux décisions simultanées ne peuvent pas
    // aboutir toutes les deux. `silent` : le contenu de la fiche (updatedAt)
    // n'est pas modifié par la décision.
    const [affected] = await def.model.update(patch, {
      where: { id, approvalStatus: STATUSES.PENDING, approvalVersion: fiche.approvalVersion },
      silent: true,
      transaction,
    });
    if (affected !== 1) {
      throw new FicheApprovalError(409, "ALREADY_DECIDED", "Cette fiche vient d'être traitée par ailleurs. Actualisez la liste.");
    }
    await History.create(
      {
        ficheType: type,
        ficheId: id,
        version: fiche.approvalVersion,
        fromStatus: STATUSES.PENDING,
        toStatus,
        changedBy: actor.id,
        changedByEmail: actor.email,
        comment: comment || null,
      },
      { transaction }
    );

    logger.info(`[FICHE-APPROVAL] ${type}/${id} v${fiche.approvalVersion} ${STATUSES.PENDING} → ${toStatus} par ${actor.email}`);
    return getDetailIn(transaction, actor, type, id);
  });
  // Après validation de la transaction : notification au créateur (sans doublon).
  try {
    await notify.notifyDecision(result, result.createdBy);
    await notify.broadcastUpdated(result);
  } catch (e) {
    logger.error(`[FICHE-APPROVAL] notification de décision ${type}/${id}: ${e.message}`);
  }
  return result;
}

async function getDetailIn(transaction, actor, type, id) {
  const fiche = await loadFiche(type, id, { transaction });
  return { ...toItem(type, fiche), history: await historyOf(type, id, transaction) };
}

const approve = (user, ficheType, id, body = {}) => decide(user, ficheType, id, body, STATUSES.APPROVED);
const reject = (user, ficheType, id, body = {}) => decide(user, ficheType, id, body, STATUSES.REJECTED);

// Nouvelle soumission après correction d'une fiche refusée (créateur
// uniquement). Le refus précédent reste dans l'historique et dans
// approvalRejectedAt / approvalRejectionComment.
async function resubmit(user, ficheType, id, body = {}) {
  const actor = actorOf(user);
  const type = String(ficheType).toLowerCase();
  const def = typeDef(type);
  const comment = String(body.comment ?? "").trim();
  if (comment.length > COMMENT_MAX) {
    throw new FicheApprovalError(400, "COMMENT_TOO_LONG", `Le commentaire ne doit pas dépasser ${COMMENT_MAX} caractères.`);
  }

  const result = await sequelize.transaction(async (transaction) => {
    const fiche = await loadFiche(type, id, { transaction });
    if (fiche.createdBy !== actor.id || !cfg.isCreator(actor.email)) {
      throw new FicheApprovalError(403, "NOT_OWNER", "Seul le créateur de la fiche peut la soumettre de nouveau.");
    }
    if (fiche.approvalStatus !== STATUSES.REJECTED) {
      throw new FicheApprovalError(409, "NOT_REJECTED", "Seule une fiche refusée peut être soumise de nouveau.");
    }
    const version = (fiche.approvalVersion || 1) + 1;
    const [affected] = await def.model.update(
      {
        approvalStatus: STATUSES.PENDING,
        approvalVersion: version,
        approvalSubmittedAt: new Date(),
        approvalDecidedAt: null,
        approvalDecidedBy: null,
        approvalDecidedByEmail: null,
      },
      { where: { id, approvalStatus: STATUSES.REJECTED, approvalVersion: fiche.approvalVersion }, silent: true, transaction }
    );
    if (affected !== 1) throw new FicheApprovalError(409, "ALREADY_RESUBMITTED", "Cette fiche a déjà été soumise de nouveau.");
    await History.create(
      {
        ficheType: type,
        ficheId: id,
        version,
        fromStatus: STATUSES.REJECTED,
        toStatus: STATUSES.PENDING,
        changedBy: actor.id,
        changedByEmail: actor.email,
        comment: comment || "Fiche corrigée et soumise de nouveau.",
      },
      { transaction }
    );
    logger.info(`[FICHE-APPROVAL] ${type}/${id} soumise de nouveau (v${version}) par ${actor.email}`);
    return getDetailIn(transaction, actor, type, id);
  });
  // Nouvelle soumission : le responsable logistique est notifié de nouveau.
  try {
    await notify.notifyPending(result, { resubmitted: true });
    await notify.broadcastUpdated(result);
  } catch (e) {
    logger.error(`[FICHE-APPROVAL] notification de nouvelle soumission ${type}/${id}: ${e.message}`);
  }
  return result;
}

module.exports = {
  FicheApprovalError,
  initialFields,
  recordCreation,
  notifyCreated,
  canCorrect,
  toApprovalBlock,
  permissionsFor,
  listFiches,
  summary,
  getDetail,
  approve,
  reject,
  resubmit,
};
