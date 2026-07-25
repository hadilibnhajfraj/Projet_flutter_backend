"use strict";

// Guarantees that the second superadmin account (issam@gmail.com) exists.
// Runs automatically at backend startup (see app.js) — idempotent, does not
// touch any other account (in particular never touches bayrem@gmail.com).

const bcrypt = require("bcrypt");
const { sequelize } = require("../db");
const User = require("../models/User");
const UserProfile = require("../models/UserProfile");

const EMAIL = "issam@gmail.com";
const PASSWORD = "221SFT0104h";
const ROLE = "superadmin2";
const NAME = "Issam";

// Defensive, idempotent guard: normally the "superadmin2" value is added to
// the enum_users_role Postgres type by migration
// 20260713105217-add-superadmin2-to-users-role-enum.js. If that migration
// hasn't been run yet on this database (fresh clone, forgotten `db:migrate`
// step before restart, ...), inserting a user with role "superadmin2" would
// fail with "invalid input value for enum enum_users_role". Running the same
// ALTER TYPE ... ADD VALUE IF NOT EXISTS here too — outside any transaction,
// as required by PostgreSQL — makes the bootstrap self-healing so the
// backend never crashes on this again, regardless of migration state.
async function ensureRoleEnumValue() {
  await sequelize.query(
    `ALTER TYPE "enum_users_role" ADD VALUE IF NOT EXISTS 'superadmin2'`
  );
}

async function ensureSuperadmin2() {
  await ensureRoleEnumValue();

  const existing = await User.findOne({ where: { email: EMAIL } });
  if (existing) return;

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  const user = await User.create({
    email: EMAIL,
    passwordHash,
    isActive: true,
    role: ROLE,
  });

  await UserProfile.create({ userId: user.id, name: NAME });

  console.log(`✅ Superadmin2 account "${EMAIL}" created`);
}

module.exports = { ensureSuperadmin2 };
