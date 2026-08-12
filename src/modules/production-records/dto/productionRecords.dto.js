"use strict";

// Normalise les fiches PorPromesh (table por_promesh) et IndustrialRecord
// (table industrial_records, module='probar') vers une forme commune pour
// la page "Fiches de production". Aucune nouvelle table : ce DTO ne fait que
// projeter les deux sources existantes vers le même contrat de réponse.
//
// Le DÉTAIL (voir buildPromeshDetail/buildProbarDetail) réutilise les DTO
// complets déjà existants de chaque module (toPorPromeshResponse,
// toIndustrialRecordResponse) plutôt que de relire les colonnes une par
// une — toute donnée déjà exposée par /por-promesh/:id ou
// /industrial-records/:id est donc disponible ici, sans duplication ni
// invention de champ.

function toCreatorRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email, role: u.role };
}

// PorPromesh a un vrai numéro de séquence Postgres ("PROMESH-2026-000001").
// IndustrialRecord (PROBAR) n'en a aucun (table partagée avec Mélange/
// Maintenance, jamais numérotée) — on ne crée pas de séquence dédiée pour ça
// (aucune nouvelle colonne/migration), on synthétise une référence lisible
// et stable à partir de l'UUID existant à la place.
function formatPromeshNumero(r) {
  if (r.sequenceNumber == null) return null;
  const year = r.createdAt ? new Date(r.createdAt).getFullYear() : new Date().getFullYear();
  return `PROMESH-${year}-${String(r.sequenceNumber).padStart(6, "0")}`;
}

function formatProbarNumero(r) {
  const year = r.createdAt ? new Date(r.createdAt).getFullYear() : new Date().getFullYear();
  const shortId = String(r.id || "").replace(/-/g, "").slice(0, 6).toUpperCase();
  return `PROBAR-${year}-${shortId}`;
}

// Le champ "Diamètre" ProBar n'a pas de colonne dédiée — stocké dans le JSON
// compact de `description` (clé "dia", voir probar_controller.dart
// `_buildComplexDataJson`/`_loadComplexFromCompactJson`). Lecture best-effort :
// une fiche ancienne ou un JSON invalide renvoie simplement `null`.
function parseProbarDescription(description) {
  if (!description || typeof description !== "string" || !description.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(description);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function extractProbarDiameter(description) {
  return parseProbarDescription(description)?.dia ?? null;
}

// ── Forme "liste" (tableau principal) — colonnes affichées uniquement ─────

function normalizePromesh(record) {
  const r = record.toJSON ? record.toJSON() : record;
  return {
    id: `promesh:${r.id}`,
    type: "promesh",
    numero: formatPromeshNumero(r),
    machine: r.machine,
    poste: r.poste,
    date: r.dateProduction,
    heureDebut: r.heureDebut,
    heureFin: r.heureFin,
    operateur: r.operateur,
    quantite: r.productionM2 != null ? Number(r.productionM2) : null,
    quantiteUnite: "m²",
    tailleMaille: r.diametreMaille1 || null,
    diametre: r.diametreMaille2 || null,
    diametreUnite: "mm",
    statut: r.status === "VALIDE" ? "validee" : "brouillon",
    isLocked: Boolean(r.isLocked),
    createdBy: r.createdBy,
    creator: toCreatorRef(r.creator),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function normalizeProbar(record) {
  const r = record.toJSON ? record.toJSON() : record;
  return {
    id: `probar:${r.id}`,
    type: "probar",
    numero: formatProbarNumero(r),
    machine: r.machine,
    poste: r.poste,
    date: r.dateFiche,
    heureDebut: null,
    heureFin: null,
    operateur: r.operateur,
    quantite: r.quantiteProduite != null ? Number(r.quantiteProduite) : null,
    quantiteUnite: "m",
    tailleMaille: null,
    diametre: extractProbarDiameter(r.description),
    diametreUnite: "mm",
    statut: r.statut === "validee" ? "validee" : "brouillon",
    isLocked: r.statut === "validee",
    createdBy: r.createdBy,
    creator: toCreatorRef(r.creator),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── Forme "détail" (drawer de la fiche) — tout ce qui existe réellement ──

// Décode le JSON compact ProBar (clés courtes, voir probar_controller.dart)
// vers une structure "paramètres techniques" lisible. Ne fabrique jamais de
// valeur : un groupe entièrement vide (aucune des clés attendues présente)
// est renvoyé à `null` pour que le frontend puisse masquer la sous-section.
function decodeProbarTechnicalData(description) {
  const d = parseProbarDescription(description);
  if (!d) return null;

  const compact = (obj) => {
    const hasValue = Object.values(obj).some((v) => v != null && String(v).trim() !== "");
    return hasValue ? obj : null;
  };

  const p = d.p || {};
  const cm = d.cm || {};
  const qm = d.qm || {};
  const ligne = (h, l, m, dia) => compact({ hauteur: qm[h] ?? null, largeur: qm[l] ?? null, maille: qm[m] ?? null, diametre: qm[dia] ?? null });

  return {
    heureDebut: d.hd || null,
    heureFin: d.hf || null,
    personnel: compact({
      responsable1: p.r1 ?? null,
      responsable2: p.r2 ?? null,
      operateur1: p.o1 ?? null,
      operateur2: p.o2 ?? null,
      aideOperateur: p.ao ?? null,
      manoeuvre: p.mn ?? null,
      stagiaire1: p.s1 ?? null,
      stagiaire2: p.s2 ?? null,
    }),
    controleMachine: compact({
      bainResine: cm.br ?? null,
      air: cm.ai ?? null,
      niveauBainEau: cm.nb ?? null,
      temperatureEau: cm.te ?? null,
      temperatureDemandee: cm.td ?? null,
      etatPistons: cm.ep ?? null,
      fluideVisuel: cm.fv ?? null,
      etatDisqueCoupe: cm.ed ?? null,
      etatAtelier: cm.ea ?? null,
      zoneStockage: cm.zs ?? null,
      justification: cm.jm ?? null,
      bobine: cm.bo ?? null,
      resistance: cm.rs ?? null,
      four: cm.fo ?? null,
      fourZone1: cm.z1 ?? null,
      fourZone2: cm.z2 ?? null,
      fourZone3: cm.z3 ?? null,
      nombreBobines: cm.nbb ?? null,
      bainEauFiltre: cm.bf ?? null,
      machineCeinture: cm.mc ?? null,
      machineBobinage: cm.mb ?? null,
    }),
    mesuresQualite: compact({
      ligne1: ligne("l1h", "l1l", "l1m", "l1d"),
      ligne2: ligne("l2h", "l2l", "l2m", "l2d"),
      ligne3: ligne("l3h", "l3l", "l3m", "l3d"),
      ligne4: ligne("l4h", "l4l", "l4m", "l4d"),
      temperature: qm.tp ?? null,
    }),
    controlesQualite: Array.isArray(d.cq) ? d.cq : [],
    note: d.n || null,
    signatureChefEquipe: d.sig || null,
    justificationControleProcess: d.jp || null,
    descriptionNonConformite: d.dnc || null,
    actionsCorrectives: d.ac || null,
  };
}

// `full` = sortie de porPromesh.dto.js#toPorPromeshResponse (déjà toutes les
// colonnes + tables enfants + créateur, voir por-promesh/dto/porPromesh.dto.js).
function buildPromeshDetail(full) {
  return {
    id: `promesh:${full.id}`,
    type: "promesh",
    numero: full.numero,
    machine: full.machine,
    poste: full.poste,
    date: full.dateProduction,
    heureDebut: full.heureDebut,
    heureFin: full.heureFin,
    heureFinTravail: full.heureFinTravail,
    operateur: full.operateur,
    quantite: full.productionM2 != null ? Number(full.productionM2) : null,
    quantiteUnite: "m²",
    tailleMaille: full.diametreMaille1 || null,
    diametre: full.diametreMaille2 || null,
    diametreUnite: "mm",
    statut: full.status === "VALIDE" ? "validee" : "brouillon",
    isLocked: Boolean(full.isLocked),
    validatedAt: full.validatedAt,
    createdBy: full.createdBy,
    creator: full.creator,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,

    personnel: full.personnelActif,
    observationPersonnel: full.observationPersonnel,
    observationsGenerales: full.observationsGenerales,
    observationFinTravail: full.observationFinTravail,

    technicalData: {
      diametreMaille3: full.diametreMaille3,
      air: full.air,
      niveauBainEau: full.niveauBainEau,
      temperatureEau: full.temperatureEau,
      temperaturePistons: full.temperaturePistons,
      etatPistons: full.etatPistons,
      fluideVisuel: full.fluideVisuel,
      etatDisqueCoupe: full.etatDisqueCoupe,
      justificationControleMachine: full.justificationControleMachine,
      justificationControleProcess: full.justificationControleProcess,
      demarrageProductionHeure1: full.demarrageProductionHeure1,
      demarrageProductionQuantite1: full.demarrageProductionQuantite1,
      demarrageProductionHeure2: full.demarrageProductionHeure2,
      demarrageProductionQuantite2: full.demarrageProductionQuantite2,
      totalMainOeuvre: full.totalMainOeuvre,
      totalChuteBarres: full.totalChuteBarres,
      totalDechetGraine: full.totalDechetGraine,
      processControl: full.processControl,
      controlesQualite: full.controlesQualite,
      arretsMachine: full.arretsMachine,
      consommations: full.consommations,
    },

    conformite: full.conformite,
    descriptionNonConformite: full.descriptionNonConformite,
    photoNonConformite: full.photoNonConformite,
    actionsCorrectives: full.actionsCorrectives,
    nonConformites: full.nonConformites,
    dateValidationProcess: full.dateValidationProcess,
    visas: {
      visaProduction: full.visaProduction,
      visaControleQualite: full.visaControleQualite,
      visaDirection: full.visaDirection,
      visaResponsableLogistiqueProcess: full.visaResponsableLogistiqueProcess,
      visaControleQualiteProcess: full.visaControleQualiteProcess,
      visaProductionProcess: full.visaProductionProcess,
    },

    attachments: full.attachments,
  };
}

// `full` = sortie de industrialRecord.dto.js#toIndustrialRecordResponse
// ({light:false}, donc `description` brut inclus — décodé ci-dessous puis
// retiré de la réponse finale pour ne pas dupliquer le JSON brut).
function buildProbarDetail(full) {
  const tech = decodeProbarTechnicalData(full.description);
  return {
    id: `probar:${full.id}`,
    type: "probar",
    numero: formatProbarNumero(full),
    machine: full.machine,
    poste: full.poste,
    date: full.dateFiche,
    heureDebut: tech?.heureDebut ?? null,
    heureFin: tech?.heureFin ?? null,
    operateur: full.operateur,
    quantite: full.quantiteProduite != null ? Number(full.quantiteProduite) : null,
    quantiteUnite: "m",
    tailleMaille: null,
    diametre: full.description ? extractProbarDiameter(full.description) : null,
    diametreUnite: "mm",
    statut: full.statut === "validee" ? "validee" : "brouillon",
    isLocked: full.statut === "validee",
    createdBy: full.createdBy,
    creator: full.creator,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,

    statutQualite: full.statutQualite,
    observations: full.observations,

    technicalData: tech
      ? {
          personnel: tech.personnel,
          controleMachine: tech.controleMachine,
          mesuresQualite: tech.mesuresQualite,
          controlesQualite: tech.controlesQualite,
          note: tech.note,
          signatureChefEquipe: tech.signatureChefEquipe,
          justificationControleProcess: tech.justificationControleProcess,
        }
      : null,
    descriptionNonConformite: tech?.descriptionNonConformite ?? null,
    actionsCorrectives: tech?.actionsCorrectives ?? null,

    // PROBAR n'a aucune infrastructure de pièces jointes (voir
    // modules/industrial-records) — toujours vide, jamais fabriqué.
    attachments: [],
  };
}

module.exports = {
  normalizePromesh,
  normalizeProbar,
  buildPromeshDetail,
  buildProbarDetail,
};
