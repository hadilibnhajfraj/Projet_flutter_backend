"use strict";

const repo = require("../repositories/industrialRecord.repository");
const logger = require("../../../utils/logger");
const User = require("../../../models/User");
const Notification = require("../../../models/Notification");
const MaintenanceActivity = require("../../../models/MaintenanceActivity");
const { sendEmail } = require("../../../services/email.service");
const { MAINTENANCE_REQUESTER_EMAIL, MAINTENANCE_NOTIFY_EMAIL } = require("../../../config/maintenanceRequester");

// responsable_logistique_achat ne voit/édite que ses propres fiches —
// admin/superadmin voient tout (même règle que POR PROMESH).
function isOwnerScoped(role) {
  return role === "responsable_logistique_achat";
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

// Garde-fou léger côté serveur pour PROBAR : empêche de marquer une fiche
// "validee" via un appel API direct si les champs de base du formulaire
// (identiques à ceux requis côté app — rendement, personnel/qualité/
// observation via le blob `description`) sont absents. Ne couvre pas le
// détail des sous-champs (Contrôle Machine/Process/Qualité), volontairement
// non bloquants par décision produit — voir probar_controller.dart.
const PROBAR_REQUIRED_ON_VALIDATE = [
  ["dateFiche", "Date de la fiche"],
  ["machine", "Machine"],
  ["poste", "Poste"],
  ["quantiteProduite", "Rendement (production)"],
  ["description", "Contenu de la fiche"],
];

function assertProbarCanValidate(record, body) {
  const merged = { ...record.get({ plain: true }), ...body };
  const missing = PROBAR_REQUIRED_ON_VALIDATE.filter(([field]) => isBlank(merged[field])).map(([, label]) => label);
  if (missing.length) {
    throw {
      status: 400,
      message: `Impossible de valider la fiche : champ(s) manquant(s) — ${missing.join(", ")}.`,
    };
  }
}

function assertOwnership(record, actor) {
  if (isOwnerScoped(actor.role) && record.createdBy !== actor.id) {
    throw { status: 403, message: "Vous ne pouvez accéder qu'à vos propres fiches" };
  }
}

// ── Demandes de maintenance — email HTML de notification ──────────────────
function _buildMaintenanceEmail({ requesterEmail, equipement, typePanne, urgence, description, dateStr }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Nouvelle demande de maintenance</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:36px 40px;text-align:center;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">🔧 Nouvelle demande de maintenance</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:40px;">
            <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6;">Bonjour,</p>
            <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
              Une nouvelle demande de maintenance vient d'être créée.
            </p>
            <p style="margin:0 0 8px;color:#374151;font-size:13px;font-weight:600;text-transform:uppercase;">Informations</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:24px;">
                <table width="100%" cellpadding="0" cellspacing="8">
                  <tr>
                    <td width="150" style="color:#6b7280;font-size:13px;font-weight:600;vertical-align:top;">👤 Demandeur</td>
                    <td style="color:#111827;font-size:14px;font-weight:600;">${requesterEmail}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:600;vertical-align:top;">🔧 Équipement</td>
                    <td style="color:#111827;font-size:14px;">${equipement}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:600;vertical-align:top;">⚠️ Type de panne</td>
                    <td style="color:#111827;font-size:14px;">${typePanne}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:600;vertical-align:top;">🚨 Urgence</td>
                    <td style="color:#111827;font-size:14px;">${urgence}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:600;vertical-align:top;">📝 Description</td>
                    <td style="color:#111827;font-size:14px;">${description}</td>
                  </tr>
                  <tr>
                    <td style="color:#6b7280;font-size:13px;font-weight:600;vertical-align:top;">📅 Date</td>
                    <td style="color:#111827;font-size:14px;">${dateStr}</td>
                  </tr>
                </table>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;color:#374151;font-size:13px;font-weight:600;text-transform:uppercase;">Statut</p>
            <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:14px 20px;margin-bottom:24px;">
              <p style="margin:0;color:#92400e;font-size:14px;font-weight:700;">En attente</p>
            </div>
            <p style="margin:0;color:#374151;font-size:14px;">Merci.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:20px 40px;text-align:center;border-top:1px solid #f3f4f6;">
            <p style="margin:0;color:#9ca3af;font-size:12px;">CBI Tunisia © ${new Date().getFullYear()}</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function createRecord(body, actor) {
  const isMaintenance = body.module === "maintenance";

  // Seul responsable_logistique@cbi-tunisia.com peut créer une demande de
  // maintenance — vérifié AVANT toute écriture : aucune fiche créée, aucun
  // email envoyé si l'utilisateur n'est pas autorisé.
  if (isMaintenance) {
    const actorEmail = (actor.email || "").toLowerCase().trim();
    if (actorEmail !== MAINTENANCE_REQUESTER_EMAIL.toLowerCase()) {
      throw { status: 403, message: "Vous n'êtes pas autorisé à créer une demande de maintenance." };
    }
  }

  const payload = { ...body, createdBy: actor.id };
  if (isMaintenance) {
    payload.statut = "En attente";
  }

  const created = await repo.create(payload);
  const record = await repo.findById(created.id);

  if (isMaintenance) {
    logger.info("Maintenance Request Created", { id: record.id, machine: record.machine, createdBy: actor.id });

    // Notification interne + historique : écrits de façon synchrone (rapides,
    // DB locale) pour que la réponse API et les tests les voient déjà créés.
    try {
      const notifyUser = await User.findOne({ where: { email: MAINTENANCE_NOTIFY_EMAIL }, attributes: ["id"] });
      if (notifyUser) {
        await Notification.create({
          userId: notifyUser.id,
          type: "MAINTENANCE_REQUEST_CREATED",
          title: "Nouvelle demande de maintenance",
          message: "Une nouvelle demande de maintenance a été créée par le responsable logistique.",
          isRead: false,
        });
        logger.info("Notification created");
      }
    } catch (e) {
      logger.error("MAINTENANCE_NOTIFICATION_ERROR:", e.message);
    }

    try {
      await MaintenanceActivity.create({
        industrialRecordId: record.id,
        userId: actor.id,
        type: "maintenance_request_created",
        message: "Nouvelle demande de maintenance créée.",
        metadata: { equipement: record.machine },
      });
    } catch (e) {
      logger.error("MAINTENANCE_ACTIVITY_ERROR:", e.message);
    }

    // Email — best-effort, fire-and-forget (I/O réseau SMTP, ne doit jamais
    // faire échouer/retarder la création de la demande).
    const dateStr = record.dateFiche
      ? new Date(record.dateFiche).toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" })
      : "—";
    const html = _buildMaintenanceEmail({
      requesterEmail: actor.email || "",
      equipement: record.machine || "—",
      typePanne: record.typePanne || "—",
      urgence: record.urgence || "—",
      description: record.description || "—",
      dateStr,
    });
    sendEmail(
      MAINTENANCE_NOTIFY_EMAIL,
      "Nouvelle demande de maintenance",
      `Nouvelle demande de maintenance créée par ${actor.email}. Équipement : ${record.machine}.`,
      { recordId: record.id },
      { html }
    )
      .then(() => logger.info(`Email sent to ${MAINTENANCE_NOTIFY_EMAIL}`))
      .catch((e) => logger.error("MAINTENANCE_EMAIL_ERROR:", e.message));
  }

  return record;
}

async function listRecords(filters, actor) {
  const where = isOwnerScoped(actor.role) ? { createdBy: actor.id } : {};
  if (filters.module) where.module = filters.module;
  if (filters.machine) where.machine = filters.machine;
  if (filters.poste) where.poste = filters.poste;

  // Pagination bornée — évite de rapatrier un historique illimité en une
  // seule requête. pageSize par défaut généreux (500) pour ne rien changer
  // au comportement actuel tant que le volume reste raisonnable.
  const page = Math.max(1, parseInt(filters.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(2000, parseInt(filters.pageSize, 10) || 500));

  const t0 = Date.now();
  const [data, total] = await Promise.all([
    repo.findAll(where, { limit: pageSize, offset: (page - 1) * pageSize }),
    repo.count(where),
  ]);
  logger.info(`[industrial-records] listRecords module=${filters.module || "*"} → ${data.length}/${total} lignes en ${Date.now() - t0}ms`);

  return { data, total };
}

async function getRecordById(id, actor) {
  const record = await repo.findById(id);
  if (!record) throw { status: 404, message: "Fiche introuvable" };
  assertOwnership(record, actor);
  return record;
}

async function updateRecord(id, body, actor) {
  const record = await repo.findBareById(id);
  if (!record) throw { status: 404, message: "Fiche introuvable" };
  assertOwnership(record, actor);

  if (body.statut === "validee" && record.module === "probar") {
    assertProbarCanValidate(record, body);
  }

  await repo.update(record, body);
  return repo.findById(id);
}

async function deleteRecord(id, actor) {
  const record = await repo.findBareById(id);
  if (!record) throw { status: 404, message: "Fiche introuvable" };
  assertOwnership(record, actor);

  await repo.destroy(record);
  return { id };
}

module.exports = { createRecord, listRecords, getRecordById, updateRecord, deleteRecord };
