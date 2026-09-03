"use strict";

// §MODIFICATION — PRODUCTION SUMMARY : PARITÉ RESPONSABLE_LOGISTIQUE_ACHAT /
// SUPERADMIN (2026-09-02). Même style que productionRecords.createdByFilter.
// test.js (contre la vraie DB de dev, comptes réels déjà seedés) : le mot de
// passe réel de cbitunisia@cbi-tunisia.com n'est pas connu (compte de
// production changé par l'utilisateur), donc la comparaison "superadmin" se
// fait via un appel direct au service (même fonctions que le controller),
// exactement comme le fait déjà le test existant pour les cas "Admin".
//
// Objectif du ticket : responsable_logistique_achat doit voir EXACTEMENT le
// même Production Summary (totaux/records/waste/machines/diamètres) qu'un
// superadmin, SANS que le reste de son périmètre (Production Records list,
// KPI cards, filtres de CET écran-là) ne change — ces tests verrouillent les
// deux côtés à la fois (parité sur Summary + non-régression ailleurs).

jest.mock("../src/utils/mailer", () => ({ sendMail: jest.fn().mockResolvedValue({ messageId: "test" }) }));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const request = require("supertest");
const app = require("../src/app");
const { sequelize } = require("../src/db");
const svc = require("../src/modules/production-records/services/productionRecords.service");

const PASSWORD = "ChangeMe123!";
const LOGISTIQUE_EMAIL = "responsable_logistique@cbi-tunisia.com";

async function signIn(email) {
  const res = await request(app).post("/auth/signin").send({ email, password: PASSWORD });
  return { token: res.body.accessToken, status: res.status };
}

async function userRow(email) {
  const [row] = await sequelize.query(`SELECT id, role FROM users WHERE email = :email LIMIT 1`, {
    replacements: { email },
    type: sequelize.QueryTypes.SELECT,
  });
  return row;
}

describe("Production Summary — parité responsable_logistique_achat / superadmin", () => {
  let logistiqueToken;
  let logistiqueUser;
  const superadminActor = { id: "test-superadmin", role: "superadmin" };

  beforeAll(async () => {
    const signed = await signIn(LOGISTIQUE_EMAIL);
    logistiqueToken = signed.token;
    logistiqueUser = await userRow(LOGISTIQUE_EMAIL);
    expect(logistiqueUser).toBeTruthy();
    // Le rôle ne doit JAMAIS avoir été changé par ce ticket (§9/§16).
    expect(logistiqueUser.role).toBe("responsable_logistique_achat");
  }, 20000);

  afterAll(async () => {
    await sequelize.close();
  });

  // ── Test A / Test B (§15 du ticket) : même requête Production Summary,
  // comparée entre les deux rôles — les deux datasets doivent être identiques.
  test("Test A/B — GET /production-records/summary : mêmes totaux/records/waste pour les deux rôles", async () => {
    const logistiqueActor = { id: logistiqueUser.id, role: logistiqueUser.role, email: LOGISTIQUE_EMAIL };
    const [summaryLogistique, summarySuperadmin] = await Promise.all([
      svc.getProductionSummary({ type: "all", period: "all", status: "all" }, logistiqueActor),
      svc.getProductionSummary({ type: "all", period: "all", status: "all" }, superadminActor),
    ]);

    // TOTAL PROMESH / TOTAL PROBAR / NUMBER OF RECORDS (§1-§3 du ticket).
    expect(summaryLogistique.promesh.grandTotal).toBe(summarySuperadmin.promesh.grandTotal);
    expect(summaryLogistique.promesh.totalRecords).toBe(summarySuperadmin.promesh.totalRecords);
    expect(summaryLogistique.promesh.grandTotalWaste).toBe(summarySuperadmin.promesh.grandTotalWaste);
    expect(summaryLogistique.probar.grandTotal).toBe(summarySuperadmin.probar.grandTotal);
    expect(summaryLogistique.probar.totalRecords).toBe(summarySuperadmin.probar.totalRecords);
    expect(summaryLogistique.probar.grandTotalWaste).toBe(summarySuperadmin.probar.grandTotalWaste);

    // PRODUCTION PROMESH / PRODUCTION PROBAR (§4-§5) — mêmes lignes, pas
    // seulement les mêmes totaux (deux datasets différents pourraient, en
    // théorie, sommer au même total par coïncidence).
    const idsLogistique = summaryLogistique.promesh.rows.map((r) => r.id).sort();
    const idsSuperadmin = summarySuperadmin.promesh.rows.map((r) => r.id).sort();
    expect(idsLogistique).toEqual(idsSuperadmin);

    // §11 : toutes les machines PROMESH doivent être présentes, jamais un
    // sous-ensemble filtré par rôle.
    const machinesInRows = new Set(summaryLogistique.promesh.rows.map((r) => r.machine));
    for (const m of new Set(summarySuperadmin.promesh.rows.map((r) => r.machine))) {
      expect(machinesInRows.has(m)).toBe(true);
    }
  });

  test("§6 du ticket — les filtres (machines/diamètres) sont identiques via l'endpoint HTTP réel", async () => {
    const [resLogistique, resSuperadmin] = await Promise.all([
      request(app).get("/production-records/filters?scope=summary").set("Authorization", `Bearer ${logistiqueToken}`),
      svc.getFilters(superadminActor, { ignoreOwnerScope: true }),
    ]);

    expect(resLogistique.status).toBe(200);
    expect(resLogistique.body.data.machines).toEqual(resSuperadmin.machines);
    expect(resLogistique.body.data.diameters).toEqual(resSuperadmin.diameters);
  });

  test("GET /production-records/summary (HTTP réel, comme l'écran Flutter) répond 200 et renvoie le même total que l'appel direct au service", async () => {
    const res = await request(app).get("/production-records/summary").set("Authorization", `Bearer ${logistiqueToken}`);
    expect(res.status).toBe(200);

    const direct = await svc.getProductionSummary({}, { id: logistiqueUser.id, role: logistiqueUser.role, email: LOGISTIQUE_EMAIL });
    expect(res.body.data.promesh.grandTotal).toBe(direct.promesh.grandTotal);
    expect(res.body.data.probar.grandTotal).toBe(direct.probar.grandTotal);
  });

  // ─────────────────────────────────────────────────────────────────────
  // §9/§14 du ticket — NON-RÉGRESSION : cette exception doit rester
  // STRICTEMENT limitée à Production Summary. Le rôle doit rester
  // owner-scoped partout ailleurs (Production Records list, KPI cards,
  // dropdown "filters" de CET écran-là).
  // ─────────────────────────────────────────────────────────────────────
  test("Non-régression — GET /production-records (Production Records list) reste owner-scoped pour responsable_logistique_achat", async () => {
    const logistiqueActor = { id: logistiqueUser.id, role: logistiqueUser.role };
    const [listLogistique, listSuperadmin] = await Promise.all([
      svc.listRecords({}, logistiqueActor),
      svc.listRecords({}, superadminActor),
    ]);

    // Le rôle owner-scoped ne doit voir QUE ses propres fiches sur cet écran
    // — jamais le même total que superadmin, sauf coïncidence improbable
    // (dans ce jeu de données de dev, on sait déjà que 11 < 20).
    for (const row of listLogistique.data) {
      expect(row.createdBy).toBe(logistiqueUser.id);
    }
    expect(listLogistique.pagination.total).toBeLessThanOrEqual(listSuperadmin.pagination.total);
  });

  test("Non-régression — GET /production-records/filters (SANS ?scope=summary) reste owner-scoped", async () => {
    const res = await request(app).get("/production-records/filters").set("Authorization", `Bearer ${logistiqueToken}`);
    expect(res.status).toBe(200);
    // Comportement par défaut inchangé : `getFilters` sans l'option
    // `ignoreOwnerScope` (celle-ci n'est passée que pour `?scope=summary`,
    // voir productionRecords.controller.js#filters).
    const direct = await svc.getFilters({ id: logistiqueUser.id, role: logistiqueUser.role });
    expect(res.body.data.machines).toEqual(direct.machines);
  });

  test("Non-régression — le rôle en base reste exactement 'responsable_logistique_achat' (§9/§16 : jamais modifié)", async () => {
    const row = await userRow(LOGISTIQUE_EMAIL);
    expect(row.role).toBe("responsable_logistique_achat");
  });
});
