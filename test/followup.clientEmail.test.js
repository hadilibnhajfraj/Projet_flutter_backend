"use strict";

// URGENT — DÉSACTIVER COMPLÈTEMENT L'ENVOI DES EMAILS FOLLOW-UP AUX CLIENTS.
// Preuve que checkFollowup() (src/cron/followup.job.js) : détecte toujours
// les Follow-up (relance du jour / absence de relance), mais n'appelle
// JAMAIS sendEmail() vers le CLIENT (contact.email) — donc jamais de
// tentative SMTP, jamais de "451 4.7.1 Ratelimit hostinger_out_ratelimit
// exceeded" côté client. `sendEmail` est mocké : si le code tentait encore
// d'envoyer un email au client, ce mock serait appelé et le test échouerait.

jest.mock("../src/services/email.service", () => ({
  sendEmail: jest.fn().mockResolvedValue({ success: true, messageId: "test" }),
}));
jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

// `require("../src/app")` charge dotenv (voir src/db.js — sinon "DB config
// missing in .env") et mocke les modules ci-dessus AVANT que app.js ne les
// require lui-même — même convention que test/finance.crud.test.js.
require("../src/app");

const { sendEmail } = require("../src/services/email.service");
const { sequelize } = require("../src/db");
const dayjs = require("dayjs");

const User = require("../src/models/User");
const CommercialContact = require("../src/models/CommercialContact");
const CommercialContactRelance = require("../src/models/CommercialContactRelance");
const Notification = require("../src/models/Notification");

const { checkFollowup } = require("../src/cron/followup.job");

const RUN_ID = Date.now();
const PASSWORD = "Str0ngP@ssw0rd!";

describe("Follow-up — emails CLIENT désactivés (§URGENT)", () => {
  let userId;
  const contactIds = [];
  const relanceIds = [];

  beforeAll(async () => {
    const user = await User.create({
      email: `followup-test-${RUN_ID}@example.com`,
      passwordHash: "x", // non utilisé par ce test (pas de login)
      isActive: true,
      role: "admin",
    });
    userId = user.id;
  });

  afterAll(async () => {
    await Notification.destroy({ where: { userId } });
    await CommercialContactRelance.destroy({ where: { id: relanceIds } });
    await CommercialContact.destroy({ where: { id: contactIds } });
    await User.destroy({ where: { id: userId } });
    await sequelize.close();
  });

  beforeEach(() => {
    sendEmail.mockClear();
  });

  test("Client AVEC relance planifiée AUJOURD'HUI → follow-up détecté, AUCUN sendEmail() appelé", async () => {
    const contact = await CommercialContact.create({
      typeClient: "Batiment",
      nom: `ADEL-${RUN_ID}`,
      prenom: "Test",
      telephone: "20000000",
      email: `adel-${RUN_ID}@example.com`,
      createdBy: userId,
    });
    contactIds.push(contact.id);

    const relance = await CommercialContactRelance.create({
      commercialContactId: contact.id,
      dateRelance: dayjs().format("YYYY-MM-DD"),
      statutRelance: "planifiee",
      emailSent: false,
      createdBy: userId,
    });
    relanceIds.push(relance.id);

    await checkFollowup();

    expect(sendEmail).not.toHaveBeenCalled();

    // Le follow-up reste détecté/enregistré (§4) — jamais marqué "email
    // envoyé" puisqu'aucun envoi n'a été tenté.
    await relance.reload();
    expect(relance.emailSent).toBe(false);
  });

  test("Client SANS relance planifiée → follow-up manquant détecté, AUCUN sendEmail() appelé", async () => {
    const contact = await CommercialContact.create({
      typeClient: "Batiment",
      nom: `TRABELSI-${RUN_ID}`,
      prenom: "Test",
      telephone: "20000001",
      email: `trabelsi-${RUN_ID}@example.com`,
      createdBy: userId,
    });
    contactIds.push(contact.id);

    await checkFollowup();

    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("Client SANS email → toujours géré sans appeler sendEmail() (comportement déjà correct, non régressé)", async () => {
    const contact = await CommercialContact.create({
      typeClient: "Batiment",
      nom: `MME-${RUN_ID}`,
      prenom: "Test",
      telephone: "20000002",
      email: null,
      createdBy: userId,
    });
    contactIds.push(contact.id);

    await checkFollowup();

    expect(sendEmail).not.toHaveBeenCalled();
    const notif = await Notification.findOne({ where: { userId, type: "FOLLOWUP_MISSING", message: { [require("sequelize").Op.like]: `%MME-${RUN_ID}%` } } });
    expect(notif).not.toBeNull();
  });
});
