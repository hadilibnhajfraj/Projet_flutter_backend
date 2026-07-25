"use strict";

const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const MaintenanceRequest = sequelize.define(
  "MaintenanceRequest",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    ticketNo: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      allowNull: false,
      unique: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    equipement: { type: DataTypes.STRING(200), allowNull: false },
    typePanne: { type: DataTypes.STRING(200), allowNull: false },
    urgence: {
      type: DataTypes.ENUM("faible", "moyenne", "critique"),
      allowNull: false,
      defaultValue: "moyenne",
    },
    description: { type: DataTypes.TEXT, allowNull: true },
    photos: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    statut: {
      type: DataTypes.ENUM("en_attente", "acceptee", "en_cours", "refusee", "terminee"),
      allowNull: false,
      defaultValue: "en_attente",
    },
    technicianId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    assignedAt: { type: DataTypes.DATE, allowNull: true },
    assignedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    startedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    acceptedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    rejectedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    completedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    rejectionReason: { type: DataTypes.TEXT, allowNull: true },
    // Date de traitement — posée à la première décision (acceptation/refus).
    processedAt: { type: DataTypes.DATE, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: "maintenance_requests",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["statut"] },
      { fields: ["urgence"] },
      { fields: ["technicianId"] },
    ],
  }
);

module.exports = MaintenanceRequest;
