require("dotenv").config();

const { sequelize } = require("../src/db");
require("../src/models/associations");
const { syncCompaniesFromProjects } = require("../src/services/companySync.service");

async function main() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });

    const result = await syncCompaniesFromProjects({ log: true });

    console.log("[company-sync] created company names:", result.companies.created);
    console.log("[company-sync] existing company names:", result.companies.existing);
    console.log("[company-sync] summary:", {
      sourceCompanies: result.sourceCompanies,
      createdCompanies: result.createdCompanies,
      existingCompanies: result.existingCompanies,
      linkedProjects: result.linkedProjects,
      skippedEntries: result.skippedEntries,
    });
  } catch (error) {
    console.error("SYNC_COMPANIES_ERROR:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
