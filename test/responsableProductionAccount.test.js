"use strict";

// Compte responsable_production@cbi-tunisia.com (BASE RÉELLE) : présent une
// seule fois, même rôle que le responsable logistique, actif, mot de passe
// haché ; le seeder officiel est idempotent et ne modifie jamais un compte
// existant. Aucun mot de passe ni jeton n'est affiché.

require("dotenv").config({ quiet: true });
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const seeder = require("../src/seeders/responsable-production.seeder");

const EMAIL = "responsable_production@cbi-tunisia.com";

afterAll(() => sequelize.close());

test("compte présent une seule fois, rôle du responsable logistique, actif, mot de passe haché, profil créé", async () => {
  const users = await User.findAll({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), EMAIL) });
  expect(users).toHaveLength(1);
  const [u] = users;
  const ref = await User.findOne({ where: { email: "responsable_logistique@cbi-tunisia.com" } });
  expect(u.role).toBe(ref.role);
  expect(u.role).toBe("responsable_logistique_achat");
  expect(["admin", "superadmin", "superadmin2"]).not.toContain(u.role);
  expect(u.isActive).toBe(true);
  expect(u.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM user_profiles WHERE "userId" = :id`, { replacements: { id: u.id } });
  expect(n).toBe(1);
});

test("seeder relancé : aucun doublon, mot de passe et rôle inchangés", async () => {
  const before = await User.findOne({ where: { email: EMAIL }, raw: true });
  const saved = process.env.RESPONSABLE_PRODUCTION_PASSWORD;
  process.env.RESPONSABLE_PRODUCTION_PASSWORD = "Autre-Mot2Passe!";
  try {
    await seeder.up(sequelize.getQueryInterface());
  } finally {
    if (saved === undefined) delete process.env.RESPONSABLE_PRODUCTION_PASSWORD;
    else process.env.RESPONSABLE_PRODUCTION_PASSWORD = saved;
  }
  const after = await User.findAll({ where: { email: EMAIL }, raw: true });
  expect(after).toHaveLength(1);
  expect(after[0].passwordHash).toBe(before.passwordHash);
  expect(after[0].role).toBe(before.role);
  expect(String(after[0].updatedAt)).toBe(String(before.updatedAt));
});

test("mot de passe initial : robustesse exigée", () => {
  for (const weak of [undefined, "", "court1!", "toutminuscule1!", "TOUTMAJUSCULE1!", "SansChiffre!", "SansSpecial123"]) {
    expect(seeder.isStrongPassword(weak)).toBe(false);
  }
  expect(seeder.isStrongPassword("Robuste-Mot2Passe!")).toBe(true);
});
