"use strict";

const dayjs = require("dayjs");

const repo = require("../repositories/recuperable.repository");
const UserProfile = require("../../../models/UserProfile");
const User = require("../../../models/User");
require("../../../models/associations");

const OPEN_WINDOW_DAYS = 6;

// responsable_logistique_achat ne voit/édite que ses propres fiches — même
// règle que POR PROMESH / IndustrialRecord. finance_production
// (§MODIFICATION — DASHBOARD PRODUCTION) est délibérément EXCLU de
// l'owner-scoping — ce rôle consulte toutes les fiches Récupérables, comme
// admin/superadmin, mais reste soumis à DELETE_ROLES.
function isOwnerScoped(role) {
  return role === "responsable_logistique_achat";
}

function assertOwnership(fiche, actor) {
  if (isOwnerScoped(actor.role) && fiche.createdBy !== actor.id) {
    throw { status: 403, message: "Vous ne pouvez accéder qu'à vos propres fiches" };
  }
}

// Une fiche reste modifiable EXACTEMENT 6 jours à partir de sa date de
// création (createdAt), OU jusqu'à ce que l'opérateur clique sur
// "Terminer" (même colonne `statut`) — recalculé à chaque appel, jamais
// depuis la seule colonne `statut` mise en cache.
function isOpen(fiche) {
  if (fiche.statut === "cloturee") return false;
  const deadline = dayjs(fiche.createdAt).add(OPEN_WINDOW_DAYS, "day");
  return dayjs().isBefore(deadline);
}

async function ensureFreshStatut(fiche) {
  if (fiche.statut === "en_cours" && !isOpen(fiche)) {
    await repo.updateFiche(fiche, { statut: "cloturee" });
  }
  return fiche;
}

function assertOpen(fiche) {
  if (!isOpen(fiche)) {
    throw {
      status: 403,
      message: "Cette fiche est terminée (ou le délai de 6 jours est dépassé) — modification interdite.",
    };
  }
}

async function resolveOperateurName(actor) {
  const profile = await UserProfile.findOne({ where: { userId: actor.id } });
  const full = `${profile?.nom ?? ""} ${profile?.prenom ?? ""}`.trim();
  if (full) return full;
  const user = await User.findByPk(actor.id);
  return user?.email ?? null;
}

// ── Enregistrement (création ou mise à jour en bloc) ────────────────────
//
// Une seule fiche par Module + Machine + Ligne + Poste + Date : si elle
// existe déjà, on l'ouvre et on met à jour ses lignes au lieu d'en créer
// une nouvelle. `recuperables` est toujours envoyé en bloc (jamais de
// champs séparés) — chaque entrée est upsertée par diamètre.
async function saveFiche(body, actor) {
  const operateur = await resolveOperateurName(actor);
  const combo = { module: body.module, machine: body.machine, ligne: body.ligne, poste: body.poste, date: body.date };

  let fiche = await repo.findFicheByCombo(combo);

  if (fiche) {
    await ensureFreshStatut(fiche);
    assertOwnership(fiche, actor);
    assertOpen(fiche);
    if (operateur && operateur !== fiche.operateur) await repo.updateFiche(fiche, { operateur });
  } else {
    const dateCloture = dayjs().add(OPEN_WINDOW_DAYS, "day").format("YYYY-MM-DD");
    try {
      fiche = await repo.createFiche({
        ...combo,
        operateur,
        statut: "en_cours",
        dateCloture,
        createdBy: actor.id,
      });
    } catch (err) {
      // Course concurrente : une autre requête a créé la fiche entre le
      // findFicheByCombo et le create() — on rejoint celle qui a gagné.
      if (err.name === "SequelizeUniqueConstraintError") {
        fiche = await repo.findFicheByCombo(combo);
      } else {
        throw err;
      }
    }
  }

  for (const item of body.recuperables || []) {
    await repo.upsertLigne(fiche.id, item.diametre, {
      dechetKg: item.dechetKg ?? 0,
      dechetProduitFiniKg: item.dechetProduitFiniKg ?? 0,
    });
  }

  return repo.findFicheById(fiche.id);
}

async function listFiches(filters, actor) {
  const where = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  if (filters.module) where.module = filters.module;
  if (filters.machine) where.machine = filters.machine;
  if (filters.ligne) where.ligne = filters.ligne;
  if (filters.poste) where.poste = filters.poste;

  const fiches = await repo.findAllFiches(where);
  await Promise.all(fiches.map(ensureFreshStatut));

  if (filters.statut) {
    return fiches.filter((f) => f.statut === filters.statut);
  }
  return fiches;
}

async function getFicheById(id, actor) {
  const fiche = await repo.findFicheById(id);
  if (!fiche) throw { status: 404, message: "Fiche introuvable" };
  assertOwnership(fiche, actor);
  await ensureFreshStatut(fiche);
  return fiche;
}

// "Terminer" — clôture manuelle immédiate, indépendante du délai de 6 jours.
async function terminerFiche(id, actor) {
  const fiche = await repo.findBareFicheById(id);
  if (!fiche) throw { status: 404, message: "Fiche introuvable" };
  assertOwnership(fiche, actor);
  await ensureFreshStatut(fiche);
  assertOpen(fiche);

  await repo.updateFiche(fiche, { statut: "cloturee" });
  return repo.findFicheById(id);
}

async function deleteFiche(id, actor) {
  const fiche = await repo.findBareFicheById(id);
  if (!fiche) throw { status: 404, message: "Fiche introuvable" };
  assertOwnership(fiche, actor);
  await ensureFreshStatut(fiche);
  assertOpen(fiche);

  await repo.destroyFiche(fiche);
  return { id };
}

module.exports = {
  saveFiche,
  listFiches,
  getFicheById,
  terminerFiche,
  deleteFiche,
  isOpen,
};
