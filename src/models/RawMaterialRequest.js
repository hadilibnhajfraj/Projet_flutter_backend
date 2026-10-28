"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

// Demande de matières premières (ISO, RESINE, … FIBRE) validée avant la création
// d'une fiche de production — voir config/rawMaterialRequest.js et
// modules/raw-material-requests. Une demande ouvre droit à UNE création de
// fiche : consumedAt / ficheType / ficheId sont renseignés à ce moment-là.
const RawMaterialRequest = sequelize.define(
  "RawMaterialRequest",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // Numéro unique lisible (DMP-AAAA-000001), voir migration 20261027090000.
    requestNumber: { type: DataTypes.STRING(30), allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    userEmail: { type: DataTypes.STRING(255), allowNull: false },
    // promesh | probar — null pour une demande faite à la connexion, valable
    // pour la prochaine fiche de l'un ou l'autre module.
    module: { type: DataTypes.STRING(20), allowNull: true },
    machine: { type: DataTypes.STRING(50), allowNull: true },
    poste: { type: DataTypes.STRING(10), allowNull: false }, // matin | nuit
    // Date de la demande en heure de Tunisie (YYYY-MM-DD).
    requestDate: { type: DataTypes.DATEONLY, allowNull: false },
    // Date de production concernée : le jour du poste pour lequel la demande est faite.
    productionDate: { type: DataTypes.DATEONLY, allowNull: false },
    // [{ material, label, reference, lot, quantiteDisponible, besoinProduction, quantiteDemandee, unite }]
    items: { type: DataTypes.JSONB, allowNull: false },
    // PENDING_VALIDATION (initial) | VALIDATED | REJECTED | IN_PROGRESS |
    // PROCESSED | SUBMITTED / DRAFT (config/rawMaterialRequest.js) — chaque
    // changement est historisé.
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: "PENDING_VALIDATION" },
    // Échéance de validation (vendredi 14 h, heure de Tunis) et envoi de l'alerte de retard.
    deadlineAt: { type: DataTypes.DATE, allowNull: true },
    lateNotifiedAt: { type: DataTypes.DATE, allowNull: true },
    rejectedAt: { type: DataTypes.DATE, allowNull: true },
    rejectedBy: { type: DataTypes.UUID, allowNull: true },
    rejectedByEmail: { type: DataTypes.STRING(255), allowNull: true },
    rejectionComment: { type: DataTypes.TEXT, allowNull: true },
    // Shift soir (migration 20261029090000) : quantités réelles par matière
    // — jamais mélangées aux lignes validées `items` —, auteur et date de
    // l'acceptation / du refus, motif du refus.
    actualItems: { type: DataTypes.JSONB, allowNull: true },
    eveningHandledAt: { type: DataTypes.DATE, allowNull: true },
    eveningHandledBy: { type: DataTypes.UUID, allowNull: true },
    eveningHandledByEmail: { type: DataTypes.STRING(255), allowNull: true },
    eveningRefusalComment: { type: DataTypes.TEXT, allowNull: true },
    validatedAt: { type: DataTypes.DATE, allowNull: true },
    validatedBy: { type: DataTypes.UUID, allowNull: true },
    validatedByEmail: { type: DataTypes.STRING(255), allowNull: true },
    // Identifiant généré par le client à l'ouverture de la popup : un double
    // clic sur « Valider la demande » renvoie la même demande, jamais une 2e.
    clientRequestId: { type: DataTypes.UUID, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    ficheType: { type: DataTypes.STRING(20), allowNull: true }, // PROMESH | PROBAR
    ficheId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    tableName: "raw_material_requests",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["userId", "clientRequestId"], name: "raw_material_requests_user_client_request_uq" },
      { fields: ["userId", "module", "poste", "consumedAt"], name: "raw_material_requests_pending_lookup" },
      { fields: ["ficheId"] },
      { unique: true, fields: ["requestNumber"], name: "raw_material_requests_request_number_uq" },
      { fields: ["requestDate"] },
      { fields: ["status"] },
      // Une seule demande par utilisateur, poste et jour (vendredi).
      { unique: true, fields: ["userId", "poste", "requestDate"], name: "raw_material_requests_user_poste_date_uq" },
      { fields: ["status", "deadlineAt"], name: "raw_material_requests_pending_deadline" },
    ],
  }
);

module.exports = RawMaterialRequest;
