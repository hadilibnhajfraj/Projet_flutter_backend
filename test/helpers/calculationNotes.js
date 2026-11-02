"use strict";

// Retire UNIQUEMENT les notes de calcul créées par un test, ainsi que leurs
// documents, historique, notifications et emails en file — après la fin des
// envois lancés en arrière-plan (flushNotifications).
const { flushNotifications, CONTEXT } = require("../../src/modules/calculation-notes/services/calculationNoteNotify.service");
const { cancelJob } = require("../../src/services/emailQueue.service");

async function purgeCalculationNotes(sql, ids) {
  await flushNotifications();
  if (!ids.length) return;
  // Nouvelles tentatives programmées (panne SMTP simulée) : arrêtées d'abord.
  const pending = await sql(`SELECT id FROM email_queue WHERE context = :ctx AND status::text IN ('PENDING','RETRYING') AND (meta->>'calculationNoteId')::int IN (:ids)`, { ctx: CONTEXT, ids });
  for (const j of pending) await cancelJob(j.id, "test");
  await sql(`DELETE FROM notifications WHERE "calculationNoteId" IN (:ids)`, { ids });
  await sql(`DELETE FROM email_queue WHERE context = :ctx AND (meta->>'calculationNoteId')::int IN (:ids)`, { ctx: CONTEXT, ids });
  await sql(`DELETE FROM calculation_note_histories WHERE "noteId" IN (:ids)`, { ids });
  await sql(`DELETE FROM calculation_note_documents WHERE "noteId" IN (:ids)`, { ids });
  await sql(`DELETE FROM calculation_notes WHERE id IN (:ids)`, { ids });
}

module.exports = { purgeCalculationNotes };
