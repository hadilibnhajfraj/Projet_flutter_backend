"use strict";

// Upload de documents Finance (§5/§12/§18) : formats acceptés (PDF/Excel/
// image), formats/tailles refusés, nom de fichier assaini (path traversal),
// accès non authentifié refusé, document inexistant → 404. Même squelette
// que test/mfa.disabled.test.js.

jest.mock("../src/utils/mailer", () => ({
  sendMail: jest.fn().mockResolvedValue({ messageId: "test" }),
}));
jest.mock("../src/services/scheduler", () => ({}));
jest.mock("../src/cron/checkProjects", () => ({}));
jest.mock("../src/cron/projectCron", () => ({}));
jest.mock("../src/cron/followup.job", () => ({}));
jest.mock("../src/cron/googleCalendarChannelRenewal.job", () => ({}));

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcrypt");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const User = require("../src/models/User");
const FinanceDocument = require("../src/models/FinanceDocument");
const FinancePurchaseOrder = require("../src/models/FinancePurchaseOrder");
const { UPLOAD_DIR } = require("../src/middleware/financeDocumentUpload.middleware");

// PNG 1x1 valide minimal (pixel transparent) — indispensable depuis que
// l'upload déclenche une vraie extraction OCR (§CORRECTION — EXTRACTION
// AUTOMATIQUE DES BONS DE COMMANDE) : des octets non-image ("fake png
// content") font planter le worker Tesseract au niveau WASM (leptonica) de
// façon non rattrapable proprement, contrairement à un vrai fichier image
// même minuscule/vide de contenu utile.
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const RUN_ID = Date.now();
const PASSWORD = "StrongPass123!";
const createdUserIds = [];
// "Inflow of raw materials" upload crée désormais un Bon de Commande (lu par
// OCR) + son document associé de façon atomique (§CORRECTION — EXTRACTION
// AUTOMATIQUE DES BONS DE COMMANDE) — res.body.data.id est l'id du BON DE
// COMMANDE, les documents vivent sous res.body.data.documents[].
const createdPurchaseOrderIds = [];
const createdDocumentIds = [];

async function createTestUser() {
  const user = await User.create({
    email: `finance-upload-${RUN_ID}@example.com`,
    passwordHash: await bcrypt.hash(PASSWORD, 12),
    isActive: true,
    role: "finance_probar",
  });
  createdUserIds.push(user.id);
  return user;
}

describe("Finance — upload de documents (Inflow of raw materials)", () => {
  let token;

  beforeAll(async () => {
    const user = await createTestUser();
    const signin = await request(app).post("/auth/signin").send({ email: user.email, password: PASSWORD });
    token = signin.body.accessToken;
  });

  afterAll(async () => {
    // Nettoie aussi les fichiers réellement écrits sur disque par les tests
    // qui ont réussi (upload PDF/XLSX/image), jamais ceux refusés (ils ne
    // sont jamais persistés par multer côté rejet fileFilter).
    const docs = await FinanceDocument.findAll({ where: { id: createdDocumentIds } });
    for (const doc of docs) {
      const filePath = path.join(UPLOAD_DIR, doc.storedFileName);
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
    await FinanceDocument.destroy({ where: { id: createdDocumentIds } });
    await FinancePurchaseOrder.destroy({ where: { id: createdPurchaseOrderIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  test("upload PDF valide → 201, Bon de Commande + document créés", async () => {
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("%PDF-1.4 fake content"), { filename: "facture.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.documents).toHaveLength(1);
    expect(res.body.data.documents[0].module).toBe("INFLOW_RAW_MATERIALS");
    expect(res.body.data.documents[0].originalName).toBe("facture.pdf");
    createdPurchaseOrderIds.push(res.body.data.id);
    createdDocumentIds.push(res.body.data.documents[0].id);
  });

  test("upload Excel (.xlsx) valide → 201", async () => {
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("fake xlsx content"), {
        filename: "stock.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(res.status).toBe(201);
    createdPurchaseOrderIds.push(res.body.data.id);
    createdDocumentIds.push(res.body.data.documents[0].id);
  });

  test("upload image (.png) valide → 201", async () => {
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", MINIMAL_PNG, { filename: "photo.png", contentType: "image/png" });

    expect(res.status).toBe(201);
    createdPurchaseOrderIds.push(res.body.data.id);
    createdDocumentIds.push(res.body.data.documents[0].id);
  });

  test("nom de fichier avec path traversal → assaini, jamais de '..' ou '/' persisté", async () => {
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("%PDF-1.4"), { filename: "../../etc/passwd.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.data.documents[0].originalName).not.toMatch(/\.\./);
    expect(res.body.data.documents[0].originalName).not.toMatch(/[/\\]/);
    createdPurchaseOrderIds.push(res.body.data.id);
    createdDocumentIds.push(res.body.data.documents[0].id);
  });

  test("format interdit (.exe) → 400", async () => {
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("MZ..."), { filename: "virus.exe", contentType: "application/x-msdownload" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("fichier trop volumineux (> 10MB) → 400", async () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 1);
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", bigBuffer, { filename: "big.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
  }, 20000);

  test("upload sans authentification → 401", async () => {
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .attach("file", Buffer.from("%PDF-1.4"), { filename: "facture.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
  });

  test("consultation d'un document inexistant → 404", async () => {
    const res = await request(app)
      .get("/finance/raw-materials/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  // NOTE : les tests d'upload de document Shipment "orphelin" (module
  // SHIPMENT sans Shipment associé, via un ancien endpoint
  // /finance/shipments/documents/upload) ont été retirés — ce workflow est
  // intentionnellement abandonné (un document SHIPMENT ne doit plus jamais
  // exister sans Shipment). Voir test/finance.crud.test.js pour la création
  // atomique Shipment + documents via POST /finance/shipments.
});
