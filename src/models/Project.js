const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Project = sequelize.define(
  "Project",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    nomProjet: { type: DataTypes.STRING(200), allowNull: false },

    dateDemarrage: { type: DataTypes.DATEONLY, allowNull: true },

    dateProspection: { type: DataTypes.DATEONLY, allowNull: true },

    typeAdresseChantier: { type: DataTypes.STRING(255), allowNull: true },

    ingenieurResponsable: { type: DataTypes.STRING(200), allowNull: true },

    engineerId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "engineers", key: "id" },
    },

    telephoneIngenieur: { type: DataTypes.STRING(30), allowNull: true },

    emailIngenieur: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    architecte: { type: DataTypes.STRING(200), allowNull: true },

    architectId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "architects", key: "id" },
    },

    telephoneArchitecte: { type: DataTypes.STRING(30), allowNull: true },

    emailArchitecte: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    matriculeFiscale: { type: DataTypes.STRING(60), allowNull: true },

    comptoir: { type: DataTypes.STRING(200), allowNull: true },

    telephoneComptoir: { type: DataTypes.STRING(30), allowNull: true },

    telephoneComptoir2: { type: DataTypes.STRING(30), allowNull: true },

    dallagiste: { type: DataTypes.STRING(200), allowNull: true },

    telephoneDallagiste: { type: DataTypes.STRING(30), allowNull: true },

    emailDallagiste: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    dateLimiteIngenieur: { type: DataTypes.DATE, allowNull: true },

    isArchived: { type: DataTypes.BOOLEAN, defaultValue: false },

    archivedAt: { type: DataTypes.DATE, allowNull: true },

    archiveReason: { type: DataTypes.TEXT, allowNull: true },

    nextRelanceDate: { type: DataTypes.DATE, allowNull: true },

    serviceTechnique: { type: DataTypes.STRING(200), allowNull: true },

    entreprise: { type: DataTypes.STRING(200), allowNull: true },

    companyId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "companies", key: "id" },
    },

    promoteur: { type: DataTypes.STRING(200), allowNull: true },

    bureauEtude: { type: DataTypes.STRING(200), allowNull: true },

    bureauControle: { type: DataTypes.STRING(200), allowNull: true },

    adresseRevendeur: { type: DataTypes.STRING(255), allowNull: true },

    montantMarche: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
      validate: { min: 0 },
    },

    adresse: { type: DataTypes.STRING(255), allowNull: true },

    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },

    localisationCommentaire: { type: DataTypes.TEXT, allowNull: true },

    lastRelanceAt: { type: DataTypes.DATE, allowNull: true },

    user_nom: DataTypes.STRING,
    user_nom_custom: DataTypes.STRING,

    statut: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: "Identification",
    },

    entrepriseFluide: { type: DataTypes.STRING(200), allowNull: true },

    entrepriseElectricite: { type: DataTypes.STRING(200), allowNull: true },

    pourcentageReussite: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      validate: { min: 0, max: 100 },
    },

    validationStatut: {
      type: DataTypes.ENUM("Validé", "Non validé"),
      allowNull: true,
      defaultValue: "Non validé",
    },

    typeProjet: { type: DataTypes.STRING(120), allowNull: true },

    projectModele: {
      type: DataTypes.ENUM("project", "revendeur", "applicateur"),
      allowNull: false,
      defaultValue: "project",
    },

    registreCommerce: { type: DataTypes.STRING(100), allowNull: true },

    fonction: {
      type: DataTypes.ENUM("achat", "gerant"),
      allowNull: true,
    },

    revendeurNom: { type: DataTypes.STRING(100), allowNull: true },

    revendeurPrenom: { type: DataTypes.STRING(100), allowNull: true },

    revendeurEmail: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    revendeurStatut: {
      type: DataTypes.ENUM("prospect", "offre", "actif", "rate"),
      allowNull: true,
      defaultValue: "prospect",
    },

    surfaceProspectee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      validate: { min: 0 },
    },

    // ── Dynamic Pipeline Stage (replaces pipelineStage ENUM) ──
    pipelineStageId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "pipeline_stages", key: "id" },
      onDelete: "SET NULL",
    },

    // ── Owner (commercial responsible) ────────────────────
    ownerId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },

    // ── CRM Priority ──────────────────────────────────────
    // Values: low | medium | high | urgent
    priority: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "medium",
    },
  },
  {
    tableName: "projects",
    timestamps: true,
    indexes: [
      { fields: ["pipelineStageId"] },
      { fields: ["ownerId"] },
      { fields: ["companyId"] },
      { fields: ["isArchived"] },
      { fields: ["projectModele"] },
      { fields: ["createdAt"] },
    ],
  }
);

// ── Default stage hook ────────────────────────────────────
// Caches the default stage ID in memory so only one DB hit per process.
// The promise resolves to a string UUID or null (if no stages are seeded yet).
let _defaultStageIdPromise = null;

async function _fetchDefaultStageId() {
  try {
    const [row] = await sequelize.query(
      `SELECT id FROM pipeline_stages
       WHERE  "deletedAt" IS NULL
       ORDER  BY "isDefault" DESC, position ASC
       LIMIT  1`,
      { type: sequelize.QueryTypes.SELECT }
    );
    return row?.id ?? null;
  } catch {
    // pipeline_stages table may not exist yet (first-time setup)
    return null;
  }
}

function getDefaultStageId() {
  if (!_defaultStageIdPromise) {
    _defaultStageIdPromise = _fetchDefaultStageId();
    // Evict cache after 5 minutes so stage changes propagate
    setTimeout(() => { _defaultStageIdPromise = null; }, 5 * 60 * 1000).unref();
  }
  return _defaultStageIdPromise;
}

// Expose so migration runner / tests can invalidate the cache
Project.invalidateDefaultStageCache = () => { _defaultStageIdPromise = null; };

Project.addHook("beforeCreate", async (project) => {
  if (project.pipelineStageId) return; // already explicitly set — skip
  const defaultId = await getDefaultStageId();
  if (defaultId) project.pipelineStageId = defaultId;
});

module.exports = Project;
