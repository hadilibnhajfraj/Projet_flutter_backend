const { Op, fn, col, where } = require("sequelize");
const { sequelize } = require("../db");
const Project = require("../models/Project");
const {
  cleanPersonName,
  findPersonByName,
  findOrCreatePersonByName,
} = require("./person.service");

const PERSON_SYNC_CONFIG = {
  engineer: {
    sourceField: "ingenieurResponsable",
    targetField: "engineerId",
    logName: "engineer-sync",
  },
  architect: {
    sourceField: "architecte",
    targetField: "architectId",
    logName: "architect-sync",
  },
};

function getConfig(type) {
  const config = PERSON_SYNC_CONFIG[type];
  if (!config) throw new Error("Invalid person sync type");
  return config;
}

function projectNameWhere(sourceField, name) {
  return where(fn("LOWER", fn("TRIM", col(sourceField))), name.toLowerCase());
}

async function getDistinctProjectPeople(type, transaction = undefined) {
  const { sourceField } = getConfig(type);
  const trimmedSource = fn("TRIM", col(sourceField));

  const rows = await Project.findAll({
    attributes: [[trimmedSource, "name"]],
    where: {
      [sourceField]: { [Op.ne]: null },
      [Op.and]: [where(trimmedSource, { [Op.ne]: "" })],
    },
    group: [trimmedSource],
    order: [[fn("LOWER", trimmedSource), "ASC"]],
    raw: true,
    transaction,
  });

  const uniqueNames = new Map();
  for (const row of rows) {
    const cleaned = cleanPersonName(row.name);
    if (!cleaned) continue;

    const key = cleaned.toLowerCase();
    if (!uniqueNames.has(key)) {
      uniqueNames.set(key, cleaned);
    }
  }

  return {
    rawCount: rows.length,
    names: [...uniqueNames.values()],
    duplicateCount: rows.length - uniqueNames.size,
  };
}

async function countSkippedProjectPeople(type, transaction = undefined) {
  const { sourceField } = getConfig(type);

  return Project.count({
    where: {
      [Op.or]: [
        { [sourceField]: null },
        where(fn("TRIM", col(sourceField)), { [Op.eq]: "" }),
      ],
    },
    transaction,
  });
}

async function syncProjectPeople(type, options = {}) {
  const config = getConfig(type);
  const logger = options.logger || console;
  const shouldLog = options.log !== false;

  const result = {
    type,
    sourceNames: 0,
    created: 0,
    existing: 0,
    linkedProjects: 0,
    skippedEntries: 0,
    names: {
      created: [],
      existing: [],
    },
  };

  await sequelize.transaction(async (transaction) => {
    const { rawCount, names, duplicateCount } = await getDistinctProjectPeople(type, transaction);
    const skippedProjects = await countSkippedProjectPeople(type, transaction);

    result.sourceNames = names.length;
    result.skippedEntries = skippedProjects + duplicateCount;

    for (const name of names) {
      const existingPerson = await findPersonByName(type, name, transaction);
      const person = existingPerson || await findOrCreatePersonByName(type, name, {}, transaction);

      if (!person) {
        result.skippedEntries += 1;
        continue;
      }

      if (existingPerson) {
        result.existing += 1;
        result.names.existing.push(person.name);
      } else {
        result.created += 1;
        result.names.created.push(person.name);
      }

      const [linkedCount] = await Project.update(
        { [config.targetField]: person.id },
        {
          where: {
            [Op.and]: [
              projectNameWhere(config.sourceField, person.name),
              {
                [Op.or]: [
                  { [config.targetField]: null },
                  { [config.targetField]: { [Op.ne]: person.id } },
                ],
              },
            ],
          },
          transaction,
        }
      );

      result.linkedProjects += linkedCount;
    }

    if (shouldLog) {
      logger.log(`[${config.logName}] distinct project values:`, rawCount);
      logger.log(`[${config.logName}] created:`, result.created);
      logger.log(`[${config.logName}] existing:`, result.existing);
      logger.log(`[${config.logName}] linked projects:`, result.linkedProjects);
      logger.log(`[${config.logName}] skipped entries:`, result.skippedEntries);
    }
  });

  return result;
}

async function syncEngineersFromProjects(options = {}) {
  return syncProjectPeople("engineer", options);
}

async function syncArchitectsFromProjects(options = {}) {
  return syncProjectPeople("architect", options);
}

async function syncPeopleFromProjects(options = {}) {
  const engineers = await syncEngineersFromProjects(options);
  const architects = await syncArchitectsFromProjects(options);

  return {
    engineers,
    architects,
  };
}

module.exports = {
  getDistinctProjectPeople,
  syncProjectPeople,
  syncEngineersFromProjects,
  syncArchitectsFromProjects,
  syncPeopleFromProjects,
};
