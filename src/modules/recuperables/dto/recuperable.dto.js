"use strict";

function toCreatorRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email, role: u.role };
}

function toItemResponse(ligne) {
  if (!ligne) return null;
  const l = ligne.toJSON ? ligne.toJSON() : ligne;
  return {
    diametre: l.diametre,
    dechetKg: l.dechetKg,
    dechetProduitFiniKg: l.dechetProduitFiniKg,
  };
}

function toFicheResponse(fiche, meta = {}) {
  if (!fiche) return null;
  const f = fiche.toJSON ? fiche.toJSON() : fiche;
  return {
    id: f.id,
    module: f.module,
    machine: f.machine,
    ligne: f.ligne,
    poste: f.poste,
    date: f.date,
    operateur: f.operateur,
    statut: f.statut,
    dateCloture: f.dateCloture,
    createdBy: f.createdBy,
    creator: toCreatorRef(f.creator),
    recuperables: (f.lignes || []).map(toItemResponse),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    ...(meta.reused ? { reused: true } : {}),
  };
}

function toFicheList(fiches) {
  return fiches.map((f) => toFicheResponse(f));
}

module.exports = { toFicheResponse, toFicheList };
