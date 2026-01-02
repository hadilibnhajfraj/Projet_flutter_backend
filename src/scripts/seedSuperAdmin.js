require("dotenv").config();
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { sequelize } = require("../db");

async function seed() {
  const email = (process.env.SUPERADMIN_EMAIL || "").toLowerCase().trim();
  const password = process.env.SUPERADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("Missing SUPERADMIN_EMAIL or SUPERADMIN_PASSWORD in .env");
  }

  await sequelize.authenticate();

  const existing = await User.findOne({ where: { email } });
  if (existing) {
    await existing.update({ role: "superadmin", isActive: true });
    console.log("Superadmin updated:", existing.email);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await User.create({
    email,
    passwordHash,
    role: "superadmin",
    isActive: true,
  });

  console.log("Superadmin created:", user.email);
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
