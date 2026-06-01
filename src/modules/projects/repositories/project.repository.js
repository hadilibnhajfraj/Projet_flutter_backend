const { Op, literal } = require("sequelize");
const Project = require("../../../models/Project");
const PipelineStage = require("../../../models/PipelineStage");
const User = require("../../../models/User");
const UserProfile = require("../../../models/UserProfile");
const ProjectAction = require("../../../models/ProjectAction");
const ProjectActionType = require("../../../models/ProjectActionType");
const ProjectReminder = require("../../../models/ProjectReminder");

// Load associations (idempotent — Node caches the module)
require("../../../models/associations");

// ── Re-usable includes ────────────────────────────────────

const STAGE_INCLUDE = {
  model: PipelineStage,
  as: "stage",
  attributes: ["id", "name", "color", "icon", "position", "isWonStage", "isLostStage"],
  required: false,
};

const OWNER_INCLUDE = {
  model: User,
  as: "owner",
  attributes: ["id", "email"],
  include: [
    {
      model: UserProfile,
      as: "profile",
      attributes: ["name", "avatarUrl"],
      required: false,
    },
  ],
  required: false,
};

// ── Correlated subqueries (efficient, no N+1) ─────────────

const ACTIONS_COUNT_ATTR = [
  literal(`(
    SELECT COUNT(*)::int
    FROM project_actions
    WHERE "projectId" = "Project".id
  )`),
  "actionsCount",
];

const NOTES_COUNT_ATTR = [
  literal(`(
    SELECT COUNT(*)::int
    FROM project_comments
    WHERE "projectId" = "Project".id
      AND "parentId" IS NULL
  )`),
  "notesCount",
];

const UPCOMING_REMINDERS_ATTR = [
  literal(`(
    SELECT COUNT(*)::int
    FROM project_reminders
    WHERE "projectId" = "Project".id
      AND "dateRelance" >= NOW()
  )`),
  "upcomingRemindersCount",
];

const ATTACHMENTS_COUNT_ATTR = [
  literal(`(
    SELECT COUNT(*)::int
    FROM project_actions
    WHERE "projectId" = "Project".id
      AND "fileUrl" IS NOT NULL
      AND "fileUrl" <> ''
  )`),
  "attachmentsCount",
];

const LAST_ACTION_ATTR = [
  literal(`(
    SELECT json_build_object(
      'id',                pa.id::text,
      'commentaire',       pa.commentaire,
      'typeAction_legacy', pa."typeAction_legacy",
      'dateAction',        pa."dateAction",
      'statut',            pa.statut,
      'fileUrl',           pa."fileUrl",
      'actionType',  CASE
        WHEN pat.id IS NOT NULL
        THEN json_build_object(
          'id',    pat.id::text,
          'name',  pat.name,
          'color', pat.color,
          'icon',  pat.icon
        )
        ELSE NULL
      END
    )
    FROM   project_actions pa
    LEFT   JOIN project_action_types pat ON pat.id = pa."actionTypeId"
    WHERE  pa."projectId" = "Project".id
    ORDER  BY pa."dateAction" DESC
    LIMIT  1
  )`),
  "lastAction",
];

// ── List-view attributes (kanban + paginated list) ────────

const LIST_ATTRIBUTES = [
  "id",
  "nomProjet",
  "typeProjet",
  "statut",
  "priority",
  "projectModele",
  "pipelineStageId",
  "ownerId",
  "isArchived",
  "pourcentageReussite",
  "montantMarche",
  "adresse",
  "latitude",
  "longitude",
  "dateDemarrage",
  "lastRelanceAt",
  "nextRelanceDate",
  "user_nom",
  "user_nom_custom",
  // completion check fields
  "telephoneIngenieur",
  "emailIngenieur",
  "architecte",
  "telephoneArchitecte",
  "emailArchitecte",
  "bureauEtude",
  "entreprise",
  "promoteur",
  "createdAt",
  "updatedAt",
  ACTIONS_COUNT_ATTR,
  NOTES_COUNT_ATTR,
  UPCOMING_REMINDERS_ATTR,
  ATTACHMENTS_COUNT_ATTR,
  LAST_ACTION_ATTR,
];

// ── Where clause builder ──────────────────────────────────

function buildBaseWhere(filters) {
  const where = {};

  if (filters.mine && filters.userId) {
    where.ownerId = filters.userId;
  } else if (filters.ownerId) {
    where.ownerId = filters.ownerId;
  }

  if (filters.stageId) where.pipelineStageId = filters.stageId;
  if (filters.projectModele) where.projectModele = filters.projectModele;

  if (filters.search) {
    where[Op.or] = [
      { nomProjet: { [Op.iLike]: `%${filters.search}%` } },
      { entreprise: { [Op.iLike]: `%${filters.search}%` } },
      { adresse: { [Op.iLike]: `%${filters.search}%` } },
      { promoteur: { [Op.iLike]: `%${filters.search}%` } },
    ];
  }

  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt[Op.gte] = new Date(filters.dateFrom);
    if (filters.dateTo) where.createdAt[Op.lte] = new Date(filters.dateTo);
  }

  return where;
}

function buildWhere(filters) {
  return { isArchived: Boolean(filters.isArchived), ...buildBaseWhere(filters) };
}

async function countStats(filters) {
  const base = buildBaseWhere(filters);
  const [total, active, archived] = await Promise.all([
    Project.count({ where: base }),
    Project.count({ where: { ...base, isArchived: false } }),
    Project.count({ where: { ...base, isArchived: true } }),
  ]);
  return { total, active, archived };
}

// ── Public API ────────────────────────────────────────────

/**
 * Paginated list with owner, stage, actionsCount, lastAction.
 */
function findPaginated(filters, { limit, offset, sortBy = "createdAt", sortDir = "DESC" }) {
  return Project.findAndCountAll({
    where: buildWhere(filters),
    attributes: LIST_ATTRIBUTES,
    include: [OWNER_INCLUDE, STAGE_INCLUDE],
    order: [[sortBy, sortDir]],
    limit,
    offset,
    distinct: true,
  });
}

/**
 * Single project with full detail includes (actions timeline, reminders).
 */
function findById(id) {
  return Project.findByPk(id, {
    attributes: [...LIST_ATTRIBUTES],
    include: [
      OWNER_INCLUDE,
      STAGE_INCLUDE,
      {
        model: ProjectAction,
        as: "actions",
        separate: true,
        order: [["dateAction", "DESC"]],
        include: [
          { model: ProjectActionType, as: "actionType" },
          {
            model: ProjectReminder,
            as: "reminders",
            separate: true,
            order: [["dateRelance", "ASC"]],
          },
        ],
      },
    ],
  });
}

/**
 * Full project detail for the edit form.
 * Fetches ALL columns (no attribute restriction) + owner (with UserProfile name)
 * + stage + full actions timeline + devisCount/bonCommandeCount subqueries.
 */
function findByIdFull(id) {
  return Project.findByPk(id, {
    attributes: {
      include: [
        [
          literal(`(SELECT COUNT(*)::int FROM project_devis WHERE "projectId" = "Project".id)`),
          "devisCount",
        ],
        [
          literal(`(SELECT COUNT(*)::int FROM project_bon_de_commande WHERE "projectId" = "Project".id)`),
          "bonCommandeCount",
        ],
        [
          literal(`(SELECT COUNT(*)::int FROM project_actions WHERE "projectId" = "Project".id)`),
          "actionsCount",
        ],
      ],
    },
    include: [
      OWNER_INCLUDE,
      STAGE_INCLUDE,
      {
        model: ProjectAction,
        as: "actions",
        separate: true,
        order: [["dateAction", "DESC"]],
        include: [
          { model: ProjectActionType, as: "actionType" },
          {
            model: ProjectReminder,
            as: "reminders",
            separate: true,
            order: [["dateRelance", "ASC"]],
          },
        ],
      },
    ],
  });
}

async function update(id, data, transaction) {
  const [, rows] = await Project.update(data, {
    where: { id },
    returning: true,
    transaction,
  });
  return rows[0] || null;
}

/**
 * All non-archived projects for Kanban view.
 * mine=false  → no ownerId filter → ALL projects
 * mine=true   → ownerId = userId  → only current user's projects
 */
function findAllForKanban({ projectModele, ownerId, search }) {
  const where = { isArchived: false };
  if (projectModele) where.projectModele = projectModele;
  if (ownerId) where.ownerId = ownerId;

  if (search) {
    where[Op.or] = [
      { nomProjet: { [Op.iLike]: `%${search}%` } },
      { entreprise: { [Op.iLike]: `%${search}%` } },
      { adresse: { [Op.iLike]: `%${search}%` } },
      { promoteur: { [Op.iLike]: `%${search}%` } },
    ];
  }

  return Project.findAll({
    where,
    attributes: LIST_ATTRIBUTES,
    include: [OWNER_INCLUDE, STAGE_INCLUDE],
    order: [["createdAt", "DESC"]],
  });
}

module.exports = { findPaginated, findById, findByIdFull, update, findAllForKanban, countStats };
