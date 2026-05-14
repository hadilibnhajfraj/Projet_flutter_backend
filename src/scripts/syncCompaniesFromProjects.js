require("dotenv").config();

const { sequelize } = require("../db");
require("../models/associations");
const { syncCompaniesFromProjects } = require("../services/companySync.service");

if (require.main === module) {
  syncCompaniesFromProjects()
    .then((result) => {
      console.log("Companies synchronized:", {
        sourceCompanies: result.sourceCompanies,
        createdCompanies: result.createdCompanies,
        existingCompanies: result.existingCompanies,
        linkedProjects: result.linkedProjects,
        skippedEntries: result.skippedEntries,
      });
    })
    .catch((error) => {
      console.error("SYNC_COMPANIES_FROM_PROJECTS_ERROR:", error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sequelize.close();
    });
}

module.exports = syncCompaniesFromProjects;
