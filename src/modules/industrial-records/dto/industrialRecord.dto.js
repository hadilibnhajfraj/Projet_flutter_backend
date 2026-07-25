"use strict";

const MELANGE_RAP_KG_GROUPS = ["a", "b", "c", "gc", "pc"];
const MELANGE_LINES = ["L1", "L2", "L3", "L4"];

function toDouble(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function rowHasValue(row) {
  if (!row || typeof row !== "object") return false;
  return Object.values(row).some((v) => String(v ?? "").trim() !== "");
}

// Résumé léger du blob `melangeData` (mêmes champs que MelangeSummary côté
// Flutter — lib/forms/industrial/view/melange/melange_summary.dart), calculé
// une seule fois côté serveur pour les vues LISTE : évite d'envoyer le JSON
// complet du formulaire (jusqu'à ~1270 champs par fiche) pour chaque ligne
// de l'historique, et évite de recalculer ce résumé à chaque build Flutter.
function toMelangeSummary(melangeData) {
  if (!melangeData || typeof melangeData !== "object") return null;

  const rav = melangeData.ravitaillement && typeof melangeData.ravitaillement === "object" ? melangeData.ravitaillement : {};
  const ravLignes = Array.isArray(rav.lignes) ? rav.lignes : [];

  const cso = Array.isArray(melangeData.consommation) ? melangeData.consommation : [];

  const rapport = melangeData.rapport && typeof melangeData.rapport === "object" ? melangeData.rapport : {};
  const rapLignes = Array.isArray(rapport.lignes) ? rapport.lignes : [];

  let totalKg = 0;
  for (const row of rapLignes) {
    if (!row || typeof row !== "object") continue;
    for (const g of MELANGE_RAP_KG_GROUPS) {
      for (const l of MELANGE_LINES) totalKg += toDouble(row[`${g}_${l}`]);
    }
  }

  return {
    heureDebut: melangeData.heureDebut ?? rapport.heureDebut ?? null,
    heureFin: melangeData.heureFin ?? rapport.heureFin ?? null,
    zone: rapport.zone ?? null,
    totalMelangeKg: totalKg,
    nbRavitaillements: ravLignes.filter(rowHasValue).length,
    nbConsommations: cso.filter(rowHasValue).length,
  };
}

function toCreatorRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email, role: u.role };
}

// `light` (vues liste/historique) omet le JSON complet `melangeData` et le
// remplace par `melangeSummary` (résumé). Le détail/l'édition d'une fiche
// (getRecord/createRecord/updateRecord) reste en mode complet par défaut.
function toIndustrialRecordResponse(record, { light = false } = {}) {
  if (!record) return null;
  const r = record.toJSON ? record.toJSON() : record;

  return {
    id: r.id,
    module: r.module,
    machine: r.machine,
    poste: r.poste,
    dateFiche: r.dateFiche,
    operateur: r.operateur,

    quantiteProduite: r.quantiteProduite,
    statutQualite: r.statutQualite,

    typePanne: r.typePanne,
    urgence: r.urgence,
    description: r.description,
    observations: r.observations,

    // Champ dédié MÉLANGE (null pour PROBAR / MAINTENANCE)
    melangeData: light ? null : (r.melangeData ?? null),
    melangeSummary: light ? toMelangeSummary(r.melangeData) : null,

    statut: r.statut,

    createdBy: r.createdBy,
    creator: toCreatorRef(r.creator),

    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toIndustrialRecordList(records) {
  return records.map((r) => toIndustrialRecordResponse(r, { light: true }));
}

module.exports = { toIndustrialRecordResponse, toIndustrialRecordList };
