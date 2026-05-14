require("dotenv").config();

const { sequelize } = require("../db");
require("../models/associations");
const { syncCompaniesFromProjects } = require("../services/companySync.service");

async function linkProjectsToCompanies() {
  return syncCompaniesFromProjects();
}

if (require.main === module) {
  linkProjectsToCompanies()
    .then((result) => {
      console.log("Projects linked to companies:", {
        sourceCompanies: result.sourceCompanies,
        createdCompanies: result.createdCompanies,
        existingCompanies: result.existingCompanies,
        linkedProjects: result.linkedProjects,
        skippedEntries: result.skippedEntries,
      });
    })
    .catch((error) => {
      console.error("LINK_PROJECTS_TO_COMPANIES_ERROR:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sequelize.close();
    });
}

module.exports = linkProjectsToCompanies;
