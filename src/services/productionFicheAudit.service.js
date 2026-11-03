"use strict";

// Journal d'audit des fiches PROBAR / PROMESH (table production_fiche_audit).
// Écrit dans la MÊME transaction que l'opération : si l'audit échoue,
// l'opération est annulée (jamais de suppression sans trace).

const ProductionFicheAudit = require("../models/ProductionFicheAudit");
const { formatPromeshNumero, formatProbarNumero } = require("../modules/production-records/dto/productionRecords.dto");

const plain = (v) => (v && typeof v.toJSON === "function" ? v.toJSON() : v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Différences entre deux états d'une fiche, limitées aux clés `keys`
 * (champs réellement envoyés par le client) : { champ: { before, after } }.
 */
function diff(before, after, keys) {
  const b = plain(before) || {};
  const a = plain(after) || {};
  const changes = {};
  for (const k of keys) {
    if (!same(b[k], a[k])) changes[k] = { before: b[k] ?? null, after: a[k] ?? null };
  }
  return changes;
}

function actorFields(actor) {
  return { userId: actor?.id || null, userEmail: actor?.email || null, userRole: actor?.role || null };
}

async function recordUpdate({ ficheType, fiche, before, after, keys, actor, lockOverride = false, transaction }) {
  const changes = diff(before, after, keys);
  if (Object.keys(changes).length === 0) return null; // rien n'a changé : aucune ligne
  return ProductionFicheAudit.create(
    { ficheType, ficheId: fiche.id, ficheNumber: ficheNumberOf(ficheType, fiche), action: "UPDATE", ...actorFields(actor), lockOverride, changes },
    { transaction }
  );
}

async function recordDelete({ ficheType, fiche, snapshot, actor, lockOverride = false, transaction }) {
  return ProductionFicheAudit.create(
    { ficheType, ficheId: fiche.id, ficheNumber: ficheNumberOf(ficheType, fiche), action: "DELETE", ...actorFields(actor), lockOverride, snapshot: plain(snapshot) },
    { transaction }
  );
}

// Même numéro que celui affiché dans l'application (DTO des fiches).
function ficheNumberOf(ficheType, fiche) {
  const f = plain(fiche) || {};
  return ficheType === "PROMESH" ? formatPromeshNumero(f) : formatProbarNumero(f);
}

module.exports = { recordUpdate, recordDelete, diff };
