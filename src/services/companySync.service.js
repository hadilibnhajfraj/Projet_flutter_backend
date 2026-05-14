const { Op, fn, col, where } = require("sequelize");
const { sequelize } = require("../db");
const Project = require("../models/Project");
const {
  cleanCompanyName,
  findCompanyByName,
  findOrCreateCompanyByName,
} = require("./company.service");

function companyNameWhere(name) {
  return where(fn("LOWER", fn("TRIM", col("entreprise"))), name.toLowerCase());
}

async function getDistinctProjectEntreprises(transaction = undefined) {
  const rows = await Project.findAll({
    attributes: [[fn("TRIM", col("entreprise")), "name"]],
    where: {
      entreprise: { [Op.ne]: null },
      [Op.and]: [where(fn("TRIM", col("entreprise")), { [Op.ne]: "" })],
    },
    group: [fn("TRIM", col("entreprise"))],
    order: [[fn("LOWER", fn("TRIM", col("entreprise"))), "ASC"]],
    raw: true,
    transaction,
  });

  const uniqueNames = new Map();

  for (const row of rows) {
    const cleaned = cleanCompanyName(row.name);
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

async function countSkippedProjectEntreprises(transaction = undefined) {
  return Project.count({
    where: {
      [Op.or]: [
        { entreprise: null },
        where(fn("TRIM", col("entreprise")), { [Op.eq]: "" }),
      ],
    },
    transaction,
  });
}

async function syncCompaniesFromProjects(options = {}) {
  const logger = options.logger || console;
  const shouldLog = options.log !== false;

  const result = {
    sourceCompanies: 0,
    createdCompanies: 0,
    existingCompanies: 0,
    linkedProjects: 0,
    skippedEntries: 0,
    companies: {
      created: [],
      existing: [],
    },
  };

  await sequelize.transaction(async (transaction) => {
    const { rawCount, names, duplicateCount } = await getDistinctProjectEntreprises(transaction);
    const skippedProjects = await countSkippedProjectEntreprises(transaction);

    result.sourceCompanies = names.length;
    result.skippedEntries = skippedProjects + duplicateCount;

    for (const name of names) {
      const existingCompany = await findCompanyByName(name, transaction);
      const company = existingCompany || await findOrCreateCompanyByName(name, transaction);
      if (!company) {
        result.skippedEntries += 1;
        continue;
      }

      if (existingCompany) {
        result.existingCompanies += 1;
        result.companies.existing.push(company.name);
      } else {
        result.createdCompanies += 1;
        result.companies.created.push(company.name);
      }

      const [linkedCount] = await Project.update(
        { companyId: company.id },
        {
          where: {
            [Op.and]: [
              companyNameWhere(company.name),
              {
                [Op.or]: [
                  { companyId: null },
                  { companyId: { [Op.ne]: company.id } },
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
      logger.log("[company-sync] distinct entreprise values:", rawCount);
      logger.log("[company-sync] created companies:", result.createdCompanies);
      logger.log("[company-sync] existing companies:", result.existingCompanies);
      logger.log("[company-sync] linked projects:", result.linkedProjects);
      logger.log("[company-sync] skipped entries:", result.skippedEntries);
    }
  });

  return result;
}

module.exports = {
  getDistinctProjectEntreprises,
  syncCompaniesFromProjects,
};
