const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Notification = sequelize.define(
  "Notification",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    type: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },

    title: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },

    message: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },

    // =========================
    // 🔥 RELATIONS FLEXIBLES
    // =========================

    projectId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    commentId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    commercialContactId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    relanceId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    maintenanceRequestId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    hrRequestId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    actionId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    qualityControlId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // Fiche de production à valider / validée / refusée (PROMESH | PROBAR) —
    // une seule notification par destinataire, type, fiche et soumission
    // (index unique partiel, migration 20261031090000).
    productionFicheType: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    productionFicheId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    productionFicheVersion: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    // Demande de matières premières concernée (ouverture directe depuis la
    // notification — migration 20261101090000).
    rawMaterialRequestId: {
      type: DataTypes.UUID,
      allowNull: true,
    },

    // =========================
    // 🔥 STATUS
    // =========================
    isRead: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    tableName: "notifications",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["isRead"] },
      { fields: ["projectId"] },
      { fields: ["commercialContactId"] },
      { fields: ["relanceId"] },
      { fields: ["maintenanceRequestId"] },
      { fields: ["hrRequestId"] },
      { fields: ["actionId"] },
      { fields: ["qualityControlId"] },
    ],
  }
);

// ── Temps réel ───────────────────────────────────────────────────────────
// Toute notification enregistrée est poussée immédiatement à son seul
// destinataire (Socket.IO, salle user:<id>) — uniquement APRÈS la validation
// de la transaction : une écriture annulée ou en échec (ex. doublon refusé
// par l'index unique) n'émet jamais rien. La notification en base reste
// l'historique durable ; l'événement ne fait que prévenir le client.
function emitAfterCommit(instances, options) {
  // Chargé ici pour éviter une dépendance circulaire au chargement des modèles.
  const { emitNotification } = require("../socket");
  const send = () => {
    for (const n of instances) {
      try {
        emitNotification(n);
      } catch (_) {
        // Le temps réel ne doit jamais faire échouer l'enregistrement.
      }
    }
  };
  if (options?.transaction) options.transaction.afterCommit(send);
  else send();
}

Notification.addHook("afterCreate", "realtimeEmit", (instance, options) => emitAfterCommit([instance], options));
Notification.addHook("afterBulkCreate", "realtimeEmit", (instances, options) => emitAfterCommit(instances, options));

module.exports = Notification;