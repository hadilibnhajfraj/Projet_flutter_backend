require("dotenv").config();
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { sequelize } = require("../db");

async function createOrUpdateSuperadmin(email, password) {
  if (!email || !password) return;

  const cleanEmail = email.toLowerCase().trim();

  const existing = await User.findOne({ where: { email: cleanEmail } });

  if (existing) {
    await existing.update({
      role: "superadmin",
      isActive: true,
    });
    console.log("Superadmin updated:", cleanEmail);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);

    await User.create({
      email: cleanEmail,
      passwordHash,
      role: "superadmin",
      isActive: true,
    });

    console.log("Superadmin created:", cleanEmail);
  }
}

async function seed() {
  await sequelize.authenticate();

  // 🔹 Superadmin principal
  await createOrUpdateSuperadmin(
    process.env.SUPERADMIN_EMAIL,
    process.env.SUPERADMIN_PASSWORD
  );

  // 🔹 Autres superadmins (SUPERADMIN_1, SUPERADMIN_2, ...)
  let index = 1;

  while (true) {
    const email = process.env[`SUPERADMIN_${index}_EMAIL`];
    const password = process.env[`SUPERADMIN_${index}_PASSWORD`];

    if (!email || !password) break;

    await createOrUpdateSuperadmin(email, password);

    index++;
  }

  console.log("\n✅ Seeding terminé");
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});