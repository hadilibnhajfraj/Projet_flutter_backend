require("dotenv").config();

const { sequelize } = require("../src/db");
require("../src/models/associations");
const { syncPeopleFromProjects } = require("../src/services/personSync.service");

async function main() {
  try {
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });

    const result = await syncPeopleFromProjects({ log: true });
    console.log("[people-sync] summary:", {
      engineers: {
        sourceNames: result.engineers.sourceNames,
        created: result.engineers.created,
        existing: result.engineers.existing,
        linkedProjects: result.engineers.linkedProjects,
        skippedEntries: result.engineers.skippedEntries,
      },
      architects: {
        sourceNames: result.architects.sourceNames,
        created: result.architects.created,
        existing: result.architects.existing,
        linkedProjects: result.architects.linkedProjects,
        skippedEntries: result.architects.skippedEntries,
      },
    });
  } catch (error) {
    console.error("SYNC_PEOPLE_ERROR:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
