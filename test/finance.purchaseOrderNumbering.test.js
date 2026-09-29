"use strict";

// Régression — HTTP 500 "Échec du traitement du Bon de Commande" sur
// POST /finance/raw-materials/upload après la SUPPRESSION d'un bon de commande.
//
// Cause : le "PO #" était calculé par COUNT(poNumber LIKE 'PO-%') + 1 alors
// que poNumber est UNIQUE. Dès qu'un bon est supprimé (DELETE
// /finance/raw-materials/:id, suppression physique), le compteur redescend
// sous le plus grand numéro existant → le numéro généré existe déjà →
// violation d'unicité → 500, à CHAQUE upload suivant (le COUNT ne change plus).
// Une base de test sans suppression ne le reproduit jamais.

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
  verifyConnection: jest.fn().mockResolvedValue({ ok: true }),
  maskEmail: (e) => e,
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const bcrypt = require("bcrypt");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const TEXT = Buffer.from(`BON DE COMMANDE N° TEST-${RUN_ID}\nClient : Test\nTotal HT : 100,000\n`);

describe("Finance — numérotation PO # après suppression d'un bon de commande", () => {
  let token;
  let userId;
  const createdIds = [];

  beforeAll(async () => {
    const user = await User.create({
      email: `finance-po-${RUN_ID}@example.com`,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      isActive: true,
      role: "finance_probar",
    });
    userId = user.id;
    token = (await request(app).post("/auth/signin").send({ email: user.email, password: PASSWORD })).body.accessToken;
  }, 20000);

  afterAll(async () => {
    for (const id of createdIds) {
      await request(app).delete(`/finance/raw-materials/${id}`).set("Authorization", `Bearer ${token}`);
    }
    await sequelize.query(`DELETE FROM finance_activities WHERE "userId" = :u`, { replacements: { u: userId } }).catch(() => {});
    await User.destroy({ where: { id: userId } });
    await sequelize.close();
  });

  const upload = (name) =>
    request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", TEXT, { filename: name, contentType: "text/plain" });

  test("upload → suppression du bon précédent → nouvel upload : 201, PO # unique", async () => {
    const a = await upload("bc-a.txt");
    expect(a.status).toBe(201);
    createdIds.push(a.body.data.id);

    const b = await upload("bc-b.txt");
    expect(b.status).toBe(201);
    createdIds.push(b.body.data.id);

    // Suppression du bon A (action utilisateur normale depuis le tableau).
    const del = await request(app).delete(`/finance/raw-materials/${a.body.data.id}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);
    createdIds.shift();

    const c = await upload("bc-c.txt");
    if (c.status !== 201) console.log("UPLOAD APRÈS SUPPRESSION →", c.status, JSON.stringify(c.body, null, 2));
    expect(c.status).toBe(201);
    createdIds.push(c.body.data.id);

    const numbers = [b.body.data.poNumber, c.body.data.poNumber];
    expect(new Set(numbers).size).toBe(2);
    // Toujours strictement supérieur au plus grand numéro existant.
    expect(Number(c.body.data.poNumber.slice(3))).toBeGreaterThan(Number(b.body.data.poNumber.slice(3)));
  });
});
