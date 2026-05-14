require("dotenv").config();

const { sequelize } = require("../src/db");
require("../src/models/associations");
const { syncEngineersFromProjects } = require("../src/services/personSync.service");

async function main() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });

    const result = await syncEngineersFromProjects({ log: true });
    console.log("[engineer-sync] created names:", result.names.created);
    console.log("[engineer-sync] existing names:", result.names.existing);
    console.log("[engineer-sync] summary:", {
      sourceNames: result.sourceNames,
      created: result.created,
      existing: result.existing,
      linkedProjects: result.linkedProjects,
      skippedEntries: result.skippedEntries,
    });
  } catch (error) {
    console.error("SYNC_ENGINEERS_ERROR:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
