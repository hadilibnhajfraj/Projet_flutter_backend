"use strict";

// CRUD Finance (§18) : documents (récupération/consultation/suppression),
// shipments (création/consultation/modification), invoices (création,
// récupération, paiement), paid-invoices (récupération). Même squelette que
// test/mfa.disabled.test.js.

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
const PDFDocument = require("pdfkit");
const { PDFParse } = require("pdf-parse");

const app = require("../src/app");
const { sequelize } = require("../src/db");
const { detectInvoiceFormat } = require("../src/modules/finance/services/invoiceFieldExtraction.service");
const { UPLOAD_DIR } = require("../src/middleware/financeDocumentUpload.middleware");
const User = require("../src/models/User");
const Client = require("../src/models/client.model");
const FinanceDocument = require("../src/models/FinanceDocument");
const FinanceShipment = require("../src/models/FinanceShipment");
const FinanceShipmentItem = require("../src/models/FinanceShipmentItem");
const FinanceInvoice = require("../src/models/FinanceInvoice");
const FinanceInvoiceItem = require("../src/models/FinanceInvoiceItem");
const FinancePayment = require("../src/models/FinancePayment");
const FinanceActivity = require("../src/models/FinanceActivity");
const FinancePurchaseOrder = require("../src/models/FinancePurchaseOrder");
const FinancePurchaseOrderItem = require("../src/models/FinancePurchaseOrderItem");

const RUN_ID = Date.now();

// Génère une vraie facture PDF (texte + tableau bordé) pour tester le
// pipeline OCR de bout en bout, pas un mock — mêmes valeurs que celles
// utilisées manuellement pour valider l'architecture avant implémentation
// (voir plan). Client/date/totaux fixes (assertions stables), invoiceNumber
// paramétrable (unicité entre tests).
function buildSyntheticInvoicePdf({ invoiceNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text(`FACTURE N: ${invoiceNumber}`, 40, 40);
    doc.fontSize(11);
    doc.text("Date: 14/08/2026", 40, 70);
    doc.text("Client: STE ABC INDUSTRIE SARL", 40, 88);
    doc.text("Tel: 71 234 567", 40, 106);
    doc.text("Adresse: Zone Industrielle, Ariana", 40, 124);
    doc.text("Matricule Fiscal: 123456A/B/M/000", 40, 142);
    doc.text(`Reference: CMD-${RUN_ID}`, 40, 160);

    const top = 200;
    const rowH = 30;
    const cols = [40, 100, 230, 270, 320, 380, 420, 460, 510, 560];
    const headers = ["Ref", "Designation", "Unite", "Diam", "Maille", "Qte", "PU HT", "Montant", "Taxe"];
    doc.rect(40, top, 570, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 2).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 570, rowH).stroke();
    const values = ["00100001", "PROMECHE FIBRE VERRE", "M2", "6", "100X100", "2500", "12,500", "31250,00", "19"];
    values.forEach((v, i) => doc.text(v, cols[i] + 3, row1 + 10, { width: cols[i + 1] - cols[i] - 6 }));

    doc.fontSize(10);
    doc.text("Sous-total HT: 31250,00", 400, row1 + 50);
    doc.text("Total Taxe: 5937,50", 400, row1 + 68);
    doc.text("Total TTC: 37187,50", 400, row1 + 86);

    doc.end();
  });
}

// Reproduit l'exemple EXACT donné par la spec "MODIFICATION CRITIQUE —
// FACTURED SHIPMENTS" (§TEST OBLIGATOIRE) : "C MF: C1836134R" (le code
// client, distinct du matricule fiscal "1836134R" qui en dérive), "Nom
// client:" (pas juste "Client:"), un tableau bordé avec Taxe1/Taxe2 séparés.
function buildExampleInvoicePdf() {
  return new Promise((resolve) => {
    // Page élargie : la désignation ("PROMECHE EN FIBRE DE VERRE FINI") est
    // trop longue pour une colonne étroite — un habillage sur 2 lignes dans
    // la cellule corromprait la valeur extraite (repérage de tableau bordé).
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text(`FACTURE N: FVL260103-${RUN_ID}`, 40, 40);
    doc.fontSize(11);
    doc.text("Date: 11/08/26", 40, 70);
    doc.text("C MF: C1836134R", 40, 88);
    doc.text("Nom client: STE 3M BUILDING SOLUTI", 40, 106);
    doc.text(`Adresse: LOT AFH LOT 159 AIN ZAGHOUAN ${RUN_ID}`, 40, 124);

    const top = 160;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 420, 470, 520, 570, 630, 670, 710];
    const headers = ["Ref", "Designation", "Unite", "Diam", "Maille", "Qte", "PU HT", "Montant", "Taxe1", "Taxe2"];
    doc.rect(40, top, 670, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 2).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 670, rowH).stroke();
    const values = ["00100001", "PROMECHE EN FIBRE DE VERRE FINI", "M2", "08", "20X20", "105,6000", "10,4000", "1 098,240", "1", "19"];
    values.forEach((v, i) => doc.text(v, cols[i] + 3, row1 + 10, { width: cols[i + 1] - cols[i] - 6 }));

    doc.end();
  });
}

// Reproduit VERBATIM le document de la spec "CORRECTION DÉFINITIVE DU
// PIPELINE D'EXTRACTION DES FACTURES" (FVL260080) : petites boîtes
// libellé/valeur en haut à gauche (Numéro/Date/N° téléphone client puis
// Référence/Matricule Fiscal client, ces deux derniers vides sur CE
// document), bloc client en haut à droite SANS aucun libellé adjacent
// (juste "C1219489FP"/nom/adresse empilés), bloc fiscal Code/Base/Taux/Taxe
// ET bloc commercial Total HT/Total TTC/Acompte/NET A PAYER côte à côte en
// bas — piège originel : les deux blocs partagent une bande Y proche, un
// texte linéaire les entrelace.
function buildSageStyleInvoicePdf({ invoiceNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(9);
    doc.text("Numéro", 40, 40);
    doc.text(invoiceNumber, 40, 54);
    doc.text("Date", 140, 40);
    doc.text("26/06/26", 140, 54);
    doc.text("N° téléphone client", 240, 40);
    doc.text("Référence", 40, 90);
    doc.text("Matricule Fiscal client", 140, 90);
    doc.text("1219489FP", 140, 104);

    doc.text("C1219489FP", 650, 40);
    doc.text("LES ASTRES PROMOTION", 650, 54);
    doc.text("IMM BADR 7EME ETAGE A72 KHEZEMA", 650, 68);
    doc.text("OUEST 4071 SOUSSE", 650, 82);

    doc.fontSize(20).text("FACTURE", 40, 140);

    const top = 190;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 420, 470, 520, 570, 620, 680, 720, 760];
    const headers = ["Référence", "Désignation", "Unité", "Diam.", "Maille", "Qté", "P.U HT", "Rms", "Montant HT", "Taxe1", "Taxe2"];
    doc.rect(40, top, 720, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 2).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 720, rowH).stroke();
    const values = ["00100001", "PROMECHE EN FIBRE DE VERRE FINI", "M²", "04", "15/15", "2116,80", "3,8000", "29%", "8043,840", "1", "19"];
    values.forEach((v, i) => doc.text(v, cols[i] + 3, row1 + 10, { width: cols[i + 1] - cols[i] - 6 }));

    // Bloc fiscal (gauche) — "Total" NU (somme Base/Taxe), jamais confondu
    // avec "Total HT"/"Total TTC" du bloc commercial voisin.
    const fiscalTop = 400;
    doc.text("Code", 40, fiscalTop);
    doc.text("Base", 100, fiscalTop);
    doc.text("Taux", 200, fiscalTop);
    doc.text("Taxe", 250, fiscalTop);
    doc.text("F1V", 40, fiscalTop + 16);
    doc.text("8 043,840", 100, fiscalTop + 16);
    doc.text("1%", 200, fiscalTop + 16);
    doc.text("80,438", 250, fiscalTop + 16);
    doc.text("C19", 40, fiscalTop + 32);
    doc.text("8 124,278", 100, fiscalTop + 32);
    doc.text("19%", 200, fiscalTop + 32);
    doc.text("1 543,613", 250, fiscalTop + 32);
    doc.text("TFV", 40, fiscalTop + 48);
    doc.text("0,000", 100, fiscalTop + 48);
    doc.text("Total", 40, fiscalTop + 64);
    doc.text("16 168,118", 100, fiscalTop + 64);
    doc.text("1 625,051", 250, fiscalTop + 64);

    // Bloc commercial (droite) — c'est la SOURCE correcte de Total HT/TTC.
    doc.text("Total HT", 450, fiscalTop);
    doc.text("Total TTC", 570, fiscalTop);
    doc.text("Acompte", 690, fiscalTop);
    doc.text("8 043,840", 450, fiscalTop + 16);
    doc.text("9 668,891", 570, fiscalTop + 16);
    doc.text("0,000", 690, fiscalTop + 16);
    doc.text("NET A PAYER", 450, fiscalTop + 40);
    doc.text("9 668,891", 450, fiscalTop + 54);

    // Conditions de règlement — mode ("Traite") juxtaposé SANS libellé propre
    // sur la même rangée que "Conditions de règlement :" (§9-13). "le" et
    // "23/07/26" délibérément posés comme DEUX mots séparés (comme sur le
    // document réel) plutôt qu'une seule chaîne : couvre la régression
    // matchColumnKey (§CORRECTION DÉFINITIVE) où "le" normalisé ne doit
    // JAMAIS être pris pour un en-tête de colonne "Libellé"/"Désignation".
    doc.text("Conditions de règlement :", 40, 520);
    doc.text("le", 260, 520);
    doc.text("23/07/26", 280, 520);
    doc.text("Traite", 420, 520);

    // Montant en toutes lettres — extrait VERBATIM, jamais utilisé pour
    // recalculer une valeur numérique.
    doc.text("Arrêtée la présente facture à la somme de :", 40, 560);
    doc.text("Neuf mille six cent soixante-huit dinars et huit cent quatre-vingt onze millimes", 40, 575);

    doc.end();
  });
}

// Même mise en page que buildSageStyleInvoicePdf, mais DEUX lignes produit
// (diamètres/mailles/quantités différents) — prouve que le repérage du
// bloc client et des totaux commerciaux ne dépend pas d'une facture à une
// seule ligne.
function buildSageStyleMultiItemInvoicePdf({ invoiceNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(9);
    doc.text("Numéro", 40, 40);
    doc.text(invoiceNumber, 40, 54);
    doc.text("Date", 140, 40);
    doc.text("02/09/26", 140, 54);
    doc.text("N° téléphone client", 240, 40);
    doc.text("71 999 888", 240, 54);
    doc.text("Référence", 40, 90);
    doc.text("Matricule Fiscal client", 140, 90);
    doc.text("0456789Q", 140, 104);

    doc.text("C0456789Q", 650, 40);
    doc.text("STE GAFSA PHOSPHATE", 650, 54);
    doc.text("ROUTE DE GABES KM 3", 650, 68);
    doc.text("2100 GAFSA", 650, 82);

    doc.fontSize(20).text("FACTURE", 40, 140);

    const top = 190;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 420, 470, 520, 570, 620, 680, 720, 760];
    const headers = ["Référence", "Désignation", "Unité", "Diam.", "Maille", "Qté", "P.U HT", "Rms", "Montant HT", "Taxe1", "Taxe2"];
    doc.rect(40, top, 720, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 3).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 720, rowH * 2).stroke();
    doc.moveTo(40, row1 + rowH).lineTo(760, row1 + rowH).stroke();
    const rowsValues = [
      ["00300003", "PROBAR EN ARMATURE SF", "ML", "10", "", "500,0000", "5,2000", "", "2600,000", "1", "19"],
      ["00100001", "PROMECHE EN FIBRE DE VERRE FINI", "M²", "06", "10/10", "310,5000", "4,1000", "29%", "1273,050", "1", "19"],
    ];
    rowsValues.forEach((values, r) => {
      const y = row1 + r * rowH + 10;
      values.forEach((v, i) => doc.text(v, cols[i] + 3, y, { width: cols[i + 1] - cols[i] - 6 }));
    });

    const fiscalTop = 460;
    doc.text("Code", 40, fiscalTop);
    doc.text("Base", 100, fiscalTop);
    doc.text("Taux", 200, fiscalTop);
    doc.text("Taxe", 250, fiscalTop);
    doc.text("C19", 40, fiscalTop + 16);
    doc.text("3 873,050", 100, fiscalTop + 16);
    doc.text("19%", 200, fiscalTop + 16);
    doc.text("735,880", 250, fiscalTop + 16);
    doc.text("Total", 40, fiscalTop + 32);
    doc.text("3 873,050", 100, fiscalTop + 32);
    doc.text("735,880", 250, fiscalTop + 32);

    doc.text("Total HT", 450, fiscalTop);
    doc.text("Total TTC", 570, fiscalTop);
    doc.text("Acompte", 690, fiscalTop);
    doc.text("3 873,050", 450, fiscalTop + 16);
    doc.text("4 608,930", 570, fiscalTop + 16);
    doc.text("500,000", 690, fiscalTop + 16);
    doc.text("NET A PAYER", 450, fiscalTop + 40);
    doc.text("4 108,930", 450, fiscalTop + 54);

    doc.end();
  });
}

// Reproduit VERBATIM l'exemple de la spec "MODIFIER LE WORKFLOW PAYMENT /
// PAID FACTURES" (§11-12) : AUCUN bloc fiscal Code/Base/Taux/Taxe, juste
// "Total HT" / "TVA" / "NET À PAYER" à plat en bas de page — piège
// spécifique : sans libellé "TVA" dédié dans l'extraction positionnelle, le
// total des taxes resterait à tort null (donc sauvegardé à 0). Même ligne
// "Conditions de règlement : le 23/07/26 Traite" que le document réel
// (FVL260096), pour couvrir la canonicalisation du mode de paiement en même
// temps.
function buildFlatTotalsInvoicePdf({ invoiceNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(9);
    doc.text("Numéro", 40, 40);
    doc.text(invoiceNumber, 40, 54);
    doc.text("Date", 140, 40);
    doc.text("26/06/26", 140, 54);

    doc.text("C7654321Z", 650, 40);
    doc.text("STE FLAT TOTALS TEST", 650, 54);
    doc.text("RUE DE LA PAIX", 650, 68);
    doc.text("1000 TUNIS", 650, 82);

    doc.fontSize(20).text("FACTURE", 40, 140);

    const top = 190;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 420, 470, 520, 570, 620, 680, 720, 760];
    const headers = ["Référence", "Désignation", "Unité", "Diam.", "Maille", "Qté", "P.U HT", "Rms", "Montant HT", "Taxe1", "Taxe2"];
    doc.rect(40, top, 720, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 2).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 720, rowH).stroke();
    const values = ["00200002", "PROMECHE FLAT TEST", "M²", "06", "10/10", "1,00", "16 741,280", "", "16 741,280", "1", "19"];
    values.forEach((v, i) => doc.text(v, cols[i] + 3, row1 + 10, { width: cols[i + 1] - cols[i] - 6 }));

    // Totaux à PLAT — pas de "Total TTC" ni de bloc Code/Base/Taux/Taxe.
    const totalsTop = 400;
    doc.text("Total HT", 450, totalsTop);
    doc.text("TVA", 570, totalsTop);
    doc.text("NET À PAYER", 690, totalsTop);
    doc.text("16 741,280", 450, totalsTop + 16);
    doc.text("3 381,065", 570, totalsTop + 16);
    doc.text("20 122,345", 690, totalsTop + 16);

    doc.text("Conditions de règlement :", 40, 460);
    doc.text("le", 260, 460);
    doc.text("23/07/26", 280, 460);
    doc.text("Traite", 420, 460);

    doc.end();
  });
}

// §CORRECTION PRIORITAIRE — EXTRACTION OCR FACTURE NADEC : reproduit
// VERBATIM la facture de référence du ticket (fournisseur NORD AFRICAINE DES
// ECHANGES COMMERCIAUX/NADEC, client COMPOSITE BUILDING INNOVATION FIRST/
// CBIF, 3 lignes produit, zone Taxes ET zone Totaux séparées, BC N° "vide",
// annotations manuscrites "Resine"/"ISO" positionnées HORS de la grille du
// tableau — jamais interprétées comme des données). Nombres imprimés en
// virgule décimale (convention tunisienne déjà utilisée par toutes les
// factures SAGE de ce fichier et par normalizeNumber) — le ticket les tape
// en notation point (ex. "960.000"), mais la VALEUR NUMÉRIQUE réellement
// vérifiée par les assertions est strictement identique quel que soit le
// séparateur choisi pour ce fixture synthétique ; un point suivi
// d'EXACTEMENT 3 chiffres est par ailleurs traité par normalizeNumber comme
// un séparateur de milliers (ambiguïté volontaire de cette fonction,
// partagée avec toutes les autres factures de ce fichier) — la virgule
// reste donc le choix fiable pour ce fixture.
function buildNADECInvoicePdf({ invoiceNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(9);
    // Bloc fournisseur (émetteur) — nom complet + sigle sur 2 lignes,
    // DISTINCTS l'un de l'autre (jamais confondu avec le bloc "Client").
    doc.text("Fournisseur", 40, 30);
    doc.text("NORD AFRICAINE DES ECHANGES COMMERCIAUX", 40, 44);
    doc.text("NADEC", 40, 58);
    doc.text("Adresse", 40, 76);
    doc.text("ZI SIDI REZIG, 2 RUE DU PLASTIQUE", 40, 90);
    doc.text("2033 MEGRINE TUNISIE", 40, 104);
    doc.text("Téléphone", 40, 122);
    doc.text("71 426 346", 40, 136);
    doc.text("TVA fournisseur", 40, 154);
    doc.text("0031422Q/A/M/000", 40, 168);

    // Bloc facture + références BL/BC/Opérateur/Vendeur/Page — propre à ce
    // format. BC N° explicitement "vide" (aucune valeur imprimée) →
    // references.bcNumber doit rester `null`, jamais une chaîne vide/devinée.
    doc.text("N° Facture", 650, 30);
    doc.text(invoiceNumber, 650, 44);
    doc.text("Date facture", 650, 58);
    doc.text("05/01/2026", 650, 72);
    doc.text("BL N°", 650, 86);
    doc.text("26/000021", 650, 100);
    doc.text("BC N°", 650, 114);
    doc.text("vide", 650, 128);
    doc.text("Opérateur", 650, 142);
    doc.text("NAWEL", 650, 156);
    doc.text("Vendeur", 650, 170);
    doc.text("NADEC", 650, 184);
    doc.text("Page", 650, 198);
    doc.text("1/1", 650, 212);

    // Bloc "Client" — nom complet + sigle sur 2 lignes FUSIONNÉS (contrairement
    // au fournisseur), code/identifiant client ET "Code TVA" DISTINCTS.
    doc.text("Client", 40, 190);
    doc.text("COMPOSITE BUILDING INNOVATION FIRST", 40, 204);
    doc.text("CBIF", 40, 218);
    doc.text("Code / identifiant client", 40, 236);
    doc.text("41112686", 40, 250);
    doc.text("Adresse client", 40, 268);
    doc.text("RUE 42500 EL HRAIRIA", 40, 282);
    doc.text("2051 TUNIS TUNISIE", 40, 296);
    doc.text("Code TVA", 40, 314);
    doc.text("1567517E/A/M/000", 40, 328);

    doc.fontSize(16).text("FACTURE", 40, 342);

    const top = 362;
    const rowH = 30;
    const cols = [40, 160, 380, 430, 490, 550, 620, 780];
    const headers = ["N° Article", "Désignation", "Unité", "Qté", "P.U HT", "Taxe", "MT Net"];

    // §9-10 : annotations manuscrites ("Resine", "ISO") positionnées AU-DESSUS
    // de la ligne d'en-tête du tableau (jamais dans la grille des rangées
    // produits) — le moteur d'extraction ne doit ni les rattacher à une
    // désignation ni en faire une 4ème ligne produit fantôme.
    doc.fontSize(7);
    doc.text("Resine", 220, top - 14);
    doc.text("ISO", 520, top - 14);
    doc.fontSize(8);

    doc.rect(40, top, 740, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 4).stroke();
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    // Les 3 lignes EXACTES de l'exemple du ticket (§2) — références
    // alphanumériques conservées TELLES QUELLES (points/tirets/"/").
    const rows = [
      ["PEINTU.PE-ALK/0149", "EPOXY LAPOX AR-101 FUT 240 KG", "KG", "960,000", "9,500", "19,00", "9 120,000"],
      ["PEINTU.PE-ALK/0040", "EPOXY LAPOX AH-112 FUT 200 KG", "KG", "800,000", "14,500", "19,00", "11 600,000"],
      ["PEINTU.PE-ALK/0433", "DILUANT EL 039 FUT 200 L", "LITRE", "200,000", "2,800", "19,00", "560,000"],
    ];
    doc.rect(40, top + rowH, 740, rowH * rows.length).stroke();
    rows.forEach((values, r) => {
      if (r > 0) doc.moveTo(40, top + rowH + r * rowH).lineTo(780, top + rowH + r * rowH).stroke();
      const y = top + rowH + r * rowH + 10;
      values.forEach((v, i) => doc.text(v, cols[i] + 3, y, { width: cols[i + 1] - cols[i] - 6 }));
    });

    // Zone Taxes (§4) ET zone Totaux (§3) — DEUX blocs séparés, la même
    // valeur de taxe (4 043,200) apparaît dans les deux, jamais confondue
    // avec Assiette/Total HT/Total TTC/Timbre fiscal voisins.
    const zonesTop = 500;
    doc.fontSize(9);
    doc.text("Taux TVA", 350, zonesTop);
    doc.text("19,00 %", 350, zonesTop + 14);
    doc.text("Assiette", 460, zonesTop);
    doc.text("21 280,000", 460, zonesTop + 14);
    doc.text("Montant taxe", 350, zonesTop + 40);
    doc.text("4 043,200", 350, zonesTop + 54);

    // Zone Totaux (§3) — valeur Total TTC IMPRIMÉE (25 324,200), qui ne
    // correspond pas exactement à Total HT + Montant Taxe(s) + Timbre Fiscal
    // recalculé (25 324,200 vs 25 324,200... en réalité 21280+4043,2+1=
    // 25324,2 — cohérent ici ; conservé néanmoins comme valeur LUE, jamais
    // recalculée, conformément à la règle générale du ticket §3/§12).
    doc.text("Total HT", 620, zonesTop);
    doc.text("21 280,000", 620, zonesTop + 14);
    doc.text("Montant Net", 620, zonesTop + 28);
    doc.text("21 280,000", 620, zonesTop + 42);
    doc.text("Montant Taxe(s)", 620, zonesTop + 56);
    doc.text("4 043,200", 620, zonesTop + 70);
    doc.text("Timbre Fiscal", 620, zonesTop + 84);
    doc.text("1,000", 620, zonesTop + 98);
    doc.text("Total TTC", 620, zonesTop + 112);
    doc.text("25 324,200", 620, zonesTop + 126);

    doc.end();
  });
}

// Reproduit VERBATIM le document de la spec "CORRECTION — EXTRACTION
// AUTOMATIQUE DES BONS DE COMMANDE" (BCL260005, client NADEC) : petites
// boîtes libellé/valeur en haut à gauche (Numéro/Date/N° télécopie), bloc
// client en haut à droite SANS aucun libellé adjacent (code F0031422Q/nom/
// adresse empilés — même piège que la facture LES ASTRES PROMOTION), bloc
// "Adresse de livraison" distinct sur 5 lignes, tableau à 6 colonnes
// (Référence/Désignation/Unité/Qté/PU.HT/Montant HT, pas de Diam/Maille/
// Taxe), TOTAL HT imprimé directement (pas de bloc fiscal Base/Taux/Taxe).
function buildPurchaseOrderPdf({ orderNumber, customerCode = "F0031422Q", customerName = "NADEC" }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(9);
    doc.text("Numéro", 40, 40);
    doc.text(orderNumber, 40, 54);
    doc.text("Date", 140, 40);
    doc.text("29/04/26", 140, 54);
    doc.text("N° télécopie", 240, 40);

    doc.text(customerCode, 650, 40);
    doc.text(customerName, 650, 54);
    doc.text("Zi Sidi Rezig, Rue Du Plastique", 650, 68);
    doc.text("2033 Ben Arous", 650, 96);

    doc.fontSize(20).text("BON DE COMMANDE", 40, 140);

    doc.fontSize(9);
    doc.text("Adresse de livraison", 40, 190);
    doc.text("DEPOT", 40, 204);
    doc.text("ELHRAYRIANSTREET FACTORY N°01", 40, 218);
    doc.text("42500 TUNIS", 40, 232);
    doc.text("ELHRAYRIA", 40, 246);
    doc.text("Tunisie", 40, 260);

    const top = 300;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 430, 500, 570];
    const headers = ["Référence", "Désignation", "Unité", "Qté", "PU.HT", "Montant HT"];
    doc.rect(40, top, 530, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 4).stroke();
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 530, rowH * 3).stroke();
    doc.moveTo(40, row1 + rowH).lineTo(570, row1 + rowH).stroke();
    doc.moveTo(40, row1 + rowH * 2).lineTo(570, row1 + rowH * 2).stroke();
    const rows = [
      ["00300002", "RESINE EPOXY LAPOX AR101 GY250", "GR", "940 000", "940 000,00", "8 460,000"],
      ["00300003", "ISO MTHPA 604 M5", "GR", "880 000", "880 000,000", "12 232,000"],
      ["00300008", "DILUANT", "Millilitr", "20 000", "20 000,0000", "5 600,000"],
    ];
    rows.forEach((values, r) => {
      const y = row1 + r * rowH + 10;
      values.forEach((v, i) => doc.text(v, cols[i] + 3, y, { width: cols[i + 1] - cols[i] - 6 }));
    });

    doc.fontSize(11);
    doc.text("TOTAL HT", 450, row1 + rowH * 3 + 20);
    doc.text("26 292,000", 450, row1 + rowH * 3 + 34);

    doc.end();
  });
}

// Même principe pour un Bon de Livraison — client/livraison/totaux fixes,
// numéro paramétrable.
function buildSyntheticDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(16).text(`BON DE LIVRAISON N: ${deliveryNumber}`, 40, 40);
    doc.fontSize(11);
    doc.text("Date: 14/08/2026", 40, 70);
    doc.text("Client: STE XYZ TRADING SARL", 40, 88);
    doc.text("Tel: 98 111 222", 40, 106);
    doc.text("C MF: 555444C/A/M/000", 40, 124);
    doc.text("Adresse Siege: Route de Tunis, Nabeul", 40, 142);
    doc.text("Adresse: Zone Industrielle, Sousse", 40, 160);
    doc.text(`Reference: PO-${RUN_ID}`, 40, 178);
    doc.text("Immatricul.: 123 TUN 4567", 40, 196);
    doc.text("Construct: MERCEDES", 40, 214);
    doc.text("Chauffeur: Ali Ben Salah", 40, 232);
    doc.text("Adresse de livraison: Rue de la Republique, Sousse", 40, 250);

    const top = 280;
    const rowH = 30;
    const cols = [40, 100, 230, 270, 320, 380, 430];
    const headers = ["Ref", "Designation", "Unite", "Diam", "Maille", "Qte"];
    doc.rect(40, top, 390, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 2).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const row1 = top + rowH;
    doc.rect(40, row1, 390, rowH).stroke();
    const values = ["00200002", "TREILLIS SOUDE GALVA", "M2", "8", "150X150", "3000,500"];
    values.forEach((v, i) => doc.text(v, cols[i] + 3, row1 + 10, { width: cols[i + 1] - cols[i] - 6 }));

    doc.fontSize(10);
    doc.text("Total: 3000,500", 40, row1 + 50);

    doc.end();
  });
}

// Reproduit la mise en page réelle fournie dans la spec "MODIFICATION
// CRITIQUE" : chaque champ est un libellé SEUL sur sa ligne, la valeur sur
// la ligne suivante (pas de "Label: valeur" sur une même ligne), aucun
// tableau bordé pour le produit (un seul produit en "étiquette : valeur"
// empilées), année sur 2 chiffres, libellés "Nom client"/"Matricule Fiscal
// client"/"Adresse livraison" (sans "de")/"Gouvernorat" avec une valeur qui
// n'est PAS un des 24 gouvernorats officiels (repli sur la valeur brute).
function buildStackedDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(11);
    const lines = [
      "Numéro:",
      deliveryNumber,
      "Date:",
      "07/08/26",
      "Matricule Fiscal client:",
      "1745741ENM000",
      "Nom client:",
      "STE MK BID SOFT",
      "Adresse:",
      `IMM LA PERLA ${RUN_ID}`,
      "Gouvernorat:",
      "3027 SIJOUMI",
      "Date livraison:",
      "07/08/26",
      "Adresse livraison:",
      "SOKRA",
      "Produit:",
      "Reference:",
      "00100001",
      "Designation:",
      "PROMECHE EN FIBRE DE VERRE FINI",
      "Unit:",
      "M2",
      "Diameter:",
      "08",
      "Mesh size:",
      "20/20",
      "Quantity:",
      "79,2000",
      "Total:",
      "79,2000",
    ];
    lines.forEach((line) => doc.text(line));

    doc.end();
  });
}

// Reproduit VERBATIM le document de la spec "CORRECTION URGENTE — CUSTOMER
// SHIPMENTS OCR" : le bloc "Adresse siège" empile code client + nom + 2
// lignes d'adresse sous UN SEUL libellé (aucun sous-label), "Bon de
// livraison"/"Expédition" sont des marqueurs de section sans ":", certains
// champs utilisent "=" comme séparateur avec la valeur littérale "VIDE"
// (absence explicite), l'adresse de livraison est répétée sur 2 lignes.
function buildAdresseSiegeDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(11);
    const lines = [
      "Numéro:",
      deliveryNumber,
      "Date:",
      "07/08/26",
      "N° téléphone client:",
      "VIDE",
      "Référence:",
      "VIDE",
      "Matricule Fiscal client:",
      "1745741ENM000",
      "Adresse siège:",
      "C1745741E",
      "STE MK BID SOFT",
      "IMM LA PERLA 2",
      "3027 SIJOUMI",
      "Bon de livraison",
      "Expédition:",
      "Immatricul. = VIDE",
      "Construct = VIDE",
      "Chauffeur = VIDE",
      "Date de livraison:",
      "07/08/26",
      "Adresse de livraison:",
      "sokra",
      "sokra",
      "Produit:",
      "Référence:",
      "00100001",
      "Désignation:",
      "PROMECHE EN FIBRE DE VERRE FINI",
      "Unité:",
      "M2",
      "Diam.:",
      "08",
      "Maille:",
      "20/20",
      "Qté:",
      "79,2000",
      "TOTAL:",
      "79,2000",
    ];
    lines.forEach((line) => doc.text(line));

    doc.end();
  });
}

// Doc B — vérifie que le parser ne dépend pas UNIQUEMENT du document de test
// principal : bloc "Adresse siège" (code+nom+2 lignes d'adresse) mais avec
// un VRAI téléphone (pas VIDE, pour prouver que le lookbehind CLIENT
// n'empêche PAS d'extraire une vraie valeur ailleurs), séparateurs ":"
// classiques uniquement, tableau bordé à 2 lignes (pas le repli
// étiquette-seule), aucune section "Expédition"/camion.
function buildAdresseSiegeTabularDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(11);
    const lines = [
      "Numéro:",
      deliveryNumber,
      "Date:",
      "10/03/25",
      "N° téléphone client:",
      "71 555 666",
      "Matricule Fiscal client:",
      "987654Z",
      "Adresse siège:",
      "C987654Z",
      "STE DELTA CONSTRUCTION",
      "RUE DE LA LIBERTE",
      "2000 BIZERTE",
      "Bon de livraison",
      "Date de livraison:",
      "10/03/25",
      "Adresse de livraison:",
      "Zone Franche Bizerte",
    ];
    lines.forEach((line) => doc.text(line));

    const top = 320;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 420, 470, 520];
    const headers = ["Ref", "Designation", "Unite", "Diam", "Maille", "Qte"];
    doc.rect(40, top, 480, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 3).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const rows = [
      ["00300003", "PANNEAU ISOLANT", "M2", "10", "100/100", "50,000"],
      ["00400004", "TREILLIS ACIER", "M2", "12", "150/150", "25,500"],
    ];
    rows.forEach((values, r) => {
      const rowY = top + rowH * (r + 1);
      doc.rect(40, rowY, 480, rowH).stroke();
      values.forEach((v, i) => doc.text(v, cols[i] + 3, rowY + 10, { width: cols[i + 1] - cols[i] - 6 }));
    });

    doc.fontSize(10);
    doc.text("Total: 75,500", 40, top + rowH * 3 + 20);

    doc.end();
  });
}

// Doc C — sans bloc "Adresse siège" (retour au libellé "Nom client"
// classique), plusieurs "VIDE" mélangés à de vraies valeurs (téléphone ET
// diamètre du produit vides, tout le reste rempli), gouvernorat correspondant
// à un des 24 officiels (comparé au cas "3027 SIJOUMI" du document
// principal, qui reste tel quel).
function buildClassicMixedVideDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(11);
    const lines = [
      "Numéro:",
      deliveryNumber,
      "Date:",
      "22/11/2025",
      "N° téléphone client:",
      "VIDE",
      "Nom client:",
      "STE GAMMA DISTRIBUTION",
      "Adresse:",
      "Route de Sfax Km 5",
      "Gouvernorat:",
      "Sfax",
      "Matricule Fiscal client:",
      "456789K",
      "Immatricul.:",
      "789 TUN 1234",
      "Construct:",
      "IVECO",
      "Chauffeur:",
      "VIDE",
      "Date de livraison:",
      "22/11/2025",
      "Adresse de livraison:",
      "Depot Central Sfax",
      "Produit:",
      "Référence:",
      "00500005",
      "Désignation:",
      "GRILLAGE PLASTIFIE",
      "Unité:",
      "ML",
      "Diam.:",
      "VIDE",
      "Maille:",
      "50/50",
      "Qté:",
      "1 250,000",
      "Total:",
      "1 250,000",
    ];
    lines.forEach((line) => doc.text(line));

    doc.end();
  });
}

// Doc D — bloc "Adresse siège" avec une adresse sur 3 lignes (pas 2), section
// "Expédition" en "=" mais avec de VRAIES valeurs cette fois (pas VIDE),
// tableau bordé à 2 lignes.
function buildAdresseSiegeLongAddressDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40, size: [950, 700] });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(11);
    const lines = [
      "Numéro:",
      deliveryNumber,
      "Date:",
      "05/01/24",
      "Matricule Fiscal client:",
      "112233X",
      "Adresse siège:",
      "C112233X",
      "STE EPSILON TRAVAUX",
      "7 AVENUE HABIB BOURGUIBA",
      "RESIDENCE LES JASMINS",
      "4000 SOUSSE",
      "Expédition:",
      "Immatricul. = 456 TUN 7890",
      "Construct = RENAULT",
      "Chauffeur = Mohamed Trabelsi",
      "Date de livraison:",
      "05/01/24",
      "Adresse de livraison:",
      "Chantier Sud Sousse",
    ];
    lines.forEach((line) => doc.text(line));

    const top = 380;
    const rowH = 30;
    const cols = [40, 100, 340, 380, 420, 470, 520];
    const headers = ["Ref", "Designation", "Unite", "Diam", "Maille", "Qte"];
    doc.rect(40, top, 480, rowH).stroke();
    for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], top).lineTo(cols[i], top + rowH * 3).stroke();
    doc.fontSize(9);
    headers.forEach((h, i) => doc.text(h, cols[i] + 3, top + 10, { width: cols[i + 1] - cols[i] - 6 }));

    const rows = [
      ["00600006", "FIBRE DE VERRE TYPE A", "M2", "6", "100/100", "300,000"],
      ["00700007", "FIBRE DE VERRE TYPE B", "M2", "8", "150/150", "200,000"],
    ];
    rows.forEach((values, r) => {
      const rowY = top + rowH * (r + 1);
      doc.rect(40, rowY, 480, rowH).stroke();
      values.forEach((v, i) => doc.text(v, cols[i] + 3, rowY + 10, { width: cols[i + 1] - cols[i] - 6 }));
    });

    doc.fontSize(10);
    doc.text("Total: 500,000", 40, top + rowH * 3 + 20);

    doc.end();
  });
}

// Reproduit VERBATIM le document de la spec "CORRECTION MAJEURE — OCR
// CUSTOMER SHIPMENTS" : labels SANS ":" (juste "Numéro", "Date", ...),
// blocs séparés par des lignes vides, ET SURTOUT un tableau produits listé
// en texte empilé (en-têtes une fois, puis N groupes de valeurs) — PAS un
// tableau bordé — avec 2 lignes de produits (voir
// extractItemsFromFlatColumnBlock).
function buildFlatColumnTableDeliveryNotePdf({ deliveryNumber }) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.fontSize(11);
    const lines = [
      "Numéro",
      deliveryNumber,
      "Date",
      "10/03/26",
      "N° téléphone client",
      "VIDE",
      "Référence",
      "VIDE",
      "Matricule Fiscal client",
      "1646965S",
      "Adresse Siège",
      "C1646965S",
      "STE WW DISPLAY",
      "TUNIS",
      "Bon de livraison",
      "Expédition",
      "Immatricul.",
      "VIDE",
      "Construct",
      "VIDE",
      "Chauffeur",
      "VIDE",
      "Date de livraison",
      "10/03/26",
      "Adresse de livraison",
      "STE WW DISPLAY",
      "TUNIS",
      "Tunisie",
      "TABLEAU",
      "Référence",
      "Désignation",
      "Unité",
      "Diam.",
      "Maille",
      "Qté",
      "00200001",
      "PROBAR EN ARMATURE SF",
      "ML",
      "06",
      "VIDE",
      "1 250,00",
      "00200001",
      "PROBAR EN ARMATURE SF",
      "ML",
      "05",
      "VIDE",
      "3 230,00",
      "TOTAL",
      "4 480,0000",
    ];
    lines.forEach((line) => doc.text(line));

    doc.end();
  });
}

async function renderPdfFirstPageToPng(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const shot = await parser.getScreenshot({ scale: 2.5 });
    // getScreenshot() renvoie un Uint8Array (universel navigateur/Node), pas
    // un vrai Buffer Node — form-data/supertest .attach() exige un Buffer.
    return Buffer.from(shot.pages[0].data);
  } finally {
    await parser.destroy();
  }
}
const PASSWORD = "StrongPass123!";
const createdUserIds = [];
const createdDocumentIds = [];
const createdShipmentIds = [];
const createdInvoiceIds = [];
const createdPurchaseOrderIds = [];
let createdShipmentId;
let createdInvoiceId;

describe("Finance — CRUD (documents / shipments / invoices / payments)", () => {
  let token;
  let customerId;

  beforeAll(async () => {
    const user = await User.create({
      email: `finance-crud-${RUN_ID}@example.com`,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      isActive: true,
      role: "finance_probar",
    });
    createdUserIds.push(user.id);
    const signin = await request(app).post("/auth/signin").send({ email: user.email, password: PASSWORD });
    token = signin.body.accessToken;

    const client = await Client.findOne({ order: [["id", "ASC"]] });
    if (!client) throw new Error("Aucun client existant en base — impossible de tester Shipment/Invoice sans clients.customerId réel");
    customerId = client.id;
  });

  afterAll(async () => {
    const allShipmentIds = [createdShipmentId, ...createdShipmentIds].filter(Boolean);
    const allInvoiceIds = [createdInvoiceId, ...createdInvoiceIds].filter(Boolean);
    await FinanceActivity.destroy({
      where: { entityId: [...allShipmentIds, ...allInvoiceIds, ...createdPurchaseOrderIds, ...createdDocumentIds].filter(Boolean) },
    });
    await FinancePayment.destroy({ where: { invoiceId: allInvoiceIds } });
    await FinanceDocument.destroy({ where: { entityId: allInvoiceIds } });
    if (allInvoiceIds.length) await FinanceInvoice.destroy({ where: { id: allInvoiceIds } });
    await FinanceDocument.destroy({ where: { entityId: createdPurchaseOrderIds } });
    if (createdPurchaseOrderIds.length) await FinancePurchaseOrder.destroy({ where: { id: createdPurchaseOrderIds } });
    await FinanceDocument.destroy({ where: { entityId: allShipmentIds } });
    if (allShipmentIds.length) await FinanceShipment.destroy({ where: { id: allShipmentIds } });
    await FinanceDocument.destroy({ where: { id: createdDocumentIds } });
    await User.destroy({ where: { id: createdUserIds } });
    await sequelize.close();
  });

  // ── Documents ──────────────────────────────────────────────────────────

  // "Inflow of raw materials" upload lit désormais réellement le Bon de
  // Commande (OCR) et crée un FinancePurchaseOrder — res.body.data.id est
  // l'id du BON, pas d'un simple document (§CORRECTION — EXTRACTION
  // AUTOMATIQUE DES BONS DE COMMANDE).
  test("upload puis récupération dans la liste des bons de commande", async () => {
    const upload = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("%PDF-1.4"), { filename: `crud-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    const orderId = upload.body.data.id;
    expect(upload.body.data.documents).toHaveLength(1);
    createdPurchaseOrderIds.push(orderId);

    // Recherche par numéro/nom client (pas par nom de fichier) : ce PDF
    // illisible ("%PDF-1.4" seul) n'a rien de détecté, donc pas de filtre —
    // on vérifie juste que le bon fraîchement créé apparaît dans la liste.
    const list = await request(app).get("/finance/raw-materials").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((o) => o.id === orderId)).toBe(true);
  });

  test("consultation puis suppression d'un bon de commande", async () => {
    const upload = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("%PDF-1.4"), { filename: `to-delete-${RUN_ID}.pdf`, contentType: "application/pdf" });
    const orderId = upload.body.data.id;

    const view = await request(app).get(`/finance/raw-materials/${orderId}`).set("Authorization", `Bearer ${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.id).toBe(orderId);

    const del = await request(app).delete(`/finance/raw-materials/${orderId}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);

    const afterDelete = await request(app).get(`/finance/raw-materials/${orderId}`).set("Authorization", `Bearer ${token}`);
    expect(afterDelete.status).toBe(404);
  });

  test("'Inflow of raw materials' avec le Bon de Commande EXACT de la spec (§CORRECTION — BCL260005, client NADEC) → tous les champs extraits correctement", async () => {
    const pdf = await buildPurchaseOrderPdf({ orderNumber: `BCL260005-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdf, { filename: `bon-commande-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const order = res.body.data;

    // Identifiant métier généré par l'application (§IDENTIFICATION DES
    // DIFFÉRENTS PURCHASE ORDERS) — jamais extrait du document.
    expect(order.poNumber).toMatch(/^PO-\d{5}$/);
    expect(order.orderNumber).toBe(`BCL260005-${RUN_ID}`);
    expect(order.orderDate).toBe("2026-04-29");
    // Bloc client SANS aucun libellé adjacent (code+nom+adresse empilés,
    // repérés par la FORME du code "F0031422Q") — jamais confondu avec un
    // libellé ("Numéro", "N° télécopie"...).
    expect(order.customerCode).toBe("F0031422Q");
    expect(order.customerName).toBe("NADEC");
    expect(order.customerAddress).toBe("Zi Sidi Rezig, Rue Du Plastique, 2033 Ben Arous");
    // Adresse de LIVRAISON — bloc distinct, jamais mélangé avec l'adresse client.
    expect(order.deliveryAddress).toBe("DEPOT\nELHRAYRIANSTREET FACTORY N°01\n42500 TUNIS\nELHRAYRIA\nTunisie");
    // Total imprimé sur le document, jamais recalculé à partir de valeurs
    // mal mappées.
    expect(Number(order.totalHT)).toBeCloseTo(26292.0, 3);

    expect(order.items).toHaveLength(3);
    const [item1, item2, item3] = order.items;
    expect(item1.reference).toBe("00300002");
    expect(item1.designation).toBe("RESINE EPOXY LAPOX AR101 GY250");
    expect(item1.unit).toBe("GR");
    expect(Number(item1.quantity)).toBeCloseTo(940000, 3);
    expect(Number(item1.unitPriceHT)).toBeCloseTo(940000, 2);
    expect(Number(item1.amountHT)).toBeCloseTo(8460.0, 3);

    expect(item2.reference).toBe("00300003");
    expect(item2.designation).toBe("ISO MTHPA 604 M5");
    expect(Number(item2.quantity)).toBeCloseTo(880000, 3);
    expect(Number(item2.amountHT)).toBeCloseTo(12232.0, 3);

    expect(item3.reference).toBe("00300008");
    expect(item3.designation).toBe("DILUANT");
    expect(item3.unit).toBe("Millilitr");
    expect(Number(item3.quantity)).toBeCloseTo(20000, 4);
    expect(Number(item3.amountHT)).toBeCloseTo(5600.0, 3);

    createdPurchaseOrderIds.push(order.id);

    // Vérification directe PostgreSQL (pas seulement la réponse API).
    const dbOrder = await FinancePurchaseOrder.findByPk(order.id);
    expect(dbOrder.orderNumber).toBe(`BCL260005-${RUN_ID}`);
    expect(dbOrder.status).toBe("EXTRACTED");
    const dbItems = await FinancePurchaseOrderItem.findAll({ where: { purchaseOrderId: order.id } });
    expect(dbItems).toHaveLength(3);
  });

  test("'Inflow of raw materials' — deux Bons de Commande uploadés successivement → PO # différents, strictement séquentiels, un seul par bon (pas par ligne produit)", async () => {
    const pdfA = await buildPurchaseOrderPdf({ orderNumber: `BCL260006-${RUN_ID}`, customerCode: "F0011111A", customerName: "CLIENT A" });
    const resA = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfA, { filename: `bon-commande-a-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(resA.status).toBe(201);
    const orderA = resA.body.data;
    createdPurchaseOrderIds.push(orderA.id);

    const pdfB = await buildPurchaseOrderPdf({ orderNumber: `BCL260007-${RUN_ID}`, customerCode: "F0022222B", customerName: "CLIENT B" });
    const resB = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdfB, { filename: `bon-commande-b-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(resB.status).toBe(201);
    const orderB = resB.body.data;
    createdPurchaseOrderIds.push(orderB.id);

    expect(orderA.poNumber).toMatch(/^PO-\d{5}$/);
    expect(orderB.poNumber).toMatch(/^PO-\d{5}$/);
    // Bons DIFFÉRENTS → PO # différents, jamais le même pour deux documents
    // distincts, et strictement croissant (compteur global, jamais réutilisé).
    expect(orderB.poNumber).not.toBe(orderA.poNumber);
    expect(Number(orderB.poNumber.split("-")[1])).toBeGreaterThan(Number(orderA.poNumber.split("-")[1]));

    // Le PO # est stable dans le temps (relu identique) et — puisqu'il vit
    // sur le Purchase Order, jamais sur l'item — structurellement partagé
    // par les 3 lignes produit de orderA (impossible d'avoir un PO # par
    // ligne : FinancePurchaseOrderItem n'a pas cette colonne).
    const refetched = await request(app).get(`/finance/raw-materials/${orderA.id}`).set("Authorization", `Bearer ${token}`);
    expect(refetched.status).toBe(200);
    expect(refetched.body.data.poNumber).toBe(orderA.poNumber);
    expect(refetched.body.data.items).toHaveLength(3);
    expect(refetched.body.data.items.every((it) => !("poNumber" in it))).toBe(true);
  });

  test("'Inflow of raw materials' — même mise en page, client/produits/quantités différents → générique, pas codé en dur pour un seul document", async () => {
    const pdf = await buildPurchaseOrderPdf({
      orderNumber: `BCL999999-${RUN_ID}`,
      customerCode: "F0099999Z",
      customerName: "STE AUTRE CLIENT",
    });
    const res = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdf, { filename: `bon-commande-2-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const order = res.body.data;
    expect(order.orderNumber).toBe(`BCL999999-${RUN_ID}`);
    expect(order.customerCode).toBe("F0099999Z");
    expect(order.customerName).toBe("STE AUTRE CLIENT");
    expect(order.items).toHaveLength(3);
    createdPurchaseOrderIds.push(order.id);
  });

  // ── Shipments ──────────────────────────────────────────────────────────
  // "New shipment" (page Customer shipments) lit désormais réellement le
  // Bon de Livraison (OCR/texte PDF) — le Shipment doit être créé avec les
  // vraies données extraites, jamais un enregistrement vide.

  test("'New shipment' avec un vrai Bon de Livraison PDF → données réellement extraites (numéro, client, camion, chauffeur, produits, total)", async () => {
    const pdf = await buildSyntheticDeliveryNotePdf({ deliveryNumber: `BL-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Bon-livraison-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    // Identifiant métier généré par l'application (§MODIFICATION — CUSTOMER
    // SHIPMENTS) — jamais extrait du document, distinct de `reference`.
    expect(s.shipmentNumber).toMatch(/^SH-\d{5}$/);
    // Jamais une simple détection du nom de fichier : les valeurs viennent
    // du CONTENU du PDF, distinctes du nom de fichier utilisé ci-dessus.
    expect(s.reference).toBe(`BL-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2026-08-14");
    expect(s.customerName).toBe("STE XYZ TRADING SARL");
    expect(s.customerTaxId).toContain("555444C");
    expect(s.customerGovernorate).toBe("Sousse"); // pas "Tunis" (présent uniquement dans l'adresse du siège)
    expect(s.customerHeadOfficeAddress).toContain("Nabeul");
    expect(s.customerReference).toBe(`PO-${RUN_ID}`);
    expect(s.truckRegistration).toContain("TUN");
    expect(s.truckManufacturer).toBe("MERCEDES");
    expect(s.driverName).toBe("Ali Ben Salah");
    expect(s.deliveryAddress).toContain("Sousse");
    expect(Number(s.totalQuantity)).toBeCloseTo(3000.5, 2);
    expect(s.status).toBe("EXTRACTED");
    expect(s.documents).toHaveLength(1);

    expect(s.items.length).toBeGreaterThanOrEqual(1);
    const item = s.items[0];
    expect(item.reference).toBe("00200002");
    expect(Number(item.quantity)).toBeCloseTo(3000.5, 2);
    expect(item.diameter).toBe("8");
    expect(item.meshSize).toBe("150X150");
    expect(item.unit).toBe("M2");

    createdShipmentId = s.id;

    const list = await request(app).get("/finance/shipments").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const found = list.body.data.find((x) => x.id === s.id);
    expect(found).toBeTruthy();
    expect(found.customerName).toBe("STE XYZ TRADING SARL");

    // Vérification directe PostgreSQL, pas seulement la réponse API.
    const dbShipment = await FinanceShipment.findByPk(s.id);
    expect(dbShipment.customerName).toBe("STE XYZ TRADING SARL");
    expect(dbShipment.driverName).toBe("Ali Ben Salah");
  });

  test("'New shipment' — deux Bons de Livraison uploadés successivement → Shipment # différents, strictement séquentiels, un seul par bon (pas par ligne produit)", async () => {
    const pdfA = await buildSyntheticDeliveryNotePdf({ deliveryNumber: `BL-SHNUM-A-${RUN_ID}` });
    const resA = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdfA, { filename: `bon-livraison-a-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(resA.status).toBe(201);
    const shipmentA = resA.body.data;
    createdShipmentIds.push(shipmentA.id);

    const pdfB = await buildSyntheticDeliveryNotePdf({ deliveryNumber: `BL-SHNUM-B-${RUN_ID}` });
    const resB = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdfB, { filename: `bon-livraison-b-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(resB.status).toBe(201);
    const shipmentB = resB.body.data;
    createdShipmentIds.push(shipmentB.id);

    expect(shipmentA.shipmentNumber).toMatch(/^SH-\d{5}$/);
    expect(shipmentB.shipmentNumber).toMatch(/^SH-\d{5}$/);
    // Bons DIFFÉRENTS → Shipment # différents, jamais le même pour deux
    // documents distincts, et strictement croissant (compteur global).
    expect(shipmentB.shipmentNumber).not.toBe(shipmentA.shipmentNumber);
    expect(Number(shipmentB.shipmentNumber.split("-")[1])).toBeGreaterThan(Number(shipmentA.shipmentNumber.split("-")[1]));

    // Le Shipment # est stable (relu identique) et — puisqu'il vit sur le
    // Customer Shipment, jamais sur l'item — structurellement partagé par
    // toutes les lignes produit d'un même bon (impossible d'avoir un
    // Shipment # par ligne : FinanceShipmentItem n'a pas cette colonne).
    const refetched = await request(app).get(`/finance/shipments/${shipmentA.id}`).set("Authorization", `Bearer ${token}`);
    expect(refetched.status).toBe(200);
    expect(refetched.body.data.shipmentNumber).toBe(shipmentA.shipmentNumber);
    expect(refetched.body.data.items.every((it) => !("shipmentNumber" in it))).toBe(true);
  });

  test("'New shipment' avec deux documents → un seul Shipment (le premier fichier est analysé par OCR, les deux sont liés)", async () => {
    const pdf = await buildSyntheticDeliveryNotePdf({ deliveryNumber: `BL-B-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Bon-livraison-B-${RUN_ID}.pdf`, contentType: "application/pdf" })
      .attach("documents", Buffer.from("fake xlsx"), {
        filename: `Annexe-${RUN_ID}.xlsx`,
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.reference).toBe(`BL-B-${RUN_ID}`); // extrait du 1er fichier
    expect(res.body.data.documents).toHaveLength(2);
    createdShipmentIds.push(res.body.data.id);
  });

  test("'New shipment' avec un document totalement illisible → OCR_FAILED, jamais de valeur inventée", async () => {
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", Buffer.from("%PDF-1.4"), { filename: `illisible-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;
    expect(s.status).toBe("OCR_FAILED");
    expect(s.reference).toMatch(/^SHIP-\d{4}-\d{6}$/); // clé interne auto-générée, jamais dérivée du nom de fichier
    expect(s.reference).not.toMatch(new RegExp(String(RUN_ID)));
    expect(s.customerName).toBeNull();
    expect(s.shipmentDate).toBeNull();
    expect(s.items).toHaveLength(0);
    // Le document reste attaché même en cas d'échec total de l'OCR (§IMPORTANT).
    expect(s.documents).toHaveLength(1);
    createdShipmentIds.push(s.id);
  });

  test("'New shipment' avec un Bon de Livraison en mise en page 'étiquette : valeur' empilée (sans tableau, année 2 chiffres) → EXTRACTED", async () => {
    const pdf = await buildStackedDeliveryNotePdf({ deliveryNumber: `DEL-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Bon-livraison-empile-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    expect(s.reference).toBe(`DEL-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2026-08-07"); // "07/08/26" → année 2 chiffres
    expect(s.customerTaxId).toBe("1745741ENM000"); // "Matricule Fiscal client:" (pas confondu avec "Nom client:")
    expect(s.customerName).toBe("STE MK BID SOFT");
    expect(s.customerAddress).toContain("IMM LA PERLA");
    expect(s.customerGovernorate).toBe("3027 SIJOUMI"); // pas un des 24 gouvernorats officiels → valeur brute conservée
    // Ce document n'a pas de "Référence" au niveau document — ne doit pas
    // être confondue avec le "Reference:" du produit (même libellé).
    expect(s.customerReference).toBeNull();
    expect(s.deliveryAddress).toBe("SOKRA"); // libellé "Adresse livraison" (sans "de")
    expect(s.status).toBe("EXTRACTED");

    expect(s.items).toHaveLength(1);
    const item = s.items[0];
    expect(item.reference).toBe("00100001");
    expect(item.designation).toBe("PROMECHE EN FIBRE DE VERRE FINI");
    expect(item.unit).toBe("M2");
    expect(item.diameter).toBe("08");
    expect(item.meshSize).toBe("20X20"); // "20/20" → "20X20"
    expect(Number(item.quantity)).toBeCloseTo(79.2, 2); // "79,2000" → 79.2
    expect(Number(s.totalQuantity)).toBeCloseTo(79.2, 2);

    createdShipmentIds.push(s.id);
  });

  test("'New shipment' avec le Bon de Livraison EXACT de la spec (§CORRECTION URGENTE) — bloc 'Adresse siège', '=' + VIDE, adresse répétée", async () => {
    const pdf = await buildAdresseSiegeDeliveryNotePdf({ deliveryNumber: `DEL260245-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Bon-livraison-adresse-siege-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    expect(s.reference).toBe(`DEL260245-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2026-08-07");
    expect(s.customerPhone).toBeNull(); // "N° téléphone client: VIDE" → null, jamais "VIDE" littéral
    expect(s.customerReference).toBeNull(); // "Référence: VIDE" → null
    expect(s.customerTaxId).toBe("1745741ENM000"); // "Matricule Fiscal client:"
    // Bloc "Adresse siège" (aucun sous-libellé) : 1re ligne = code, 2e =
    // nom, reste = adresse — jamais mélangés entre eux ni avec un autre champ.
    expect(s.customerCode).toBe("C1745741E");
    expect(s.customerName).toBe("STE MK BID SOFT");
    expect(s.customerHeadOfficeAddress).toBe("IMM LA PERLA 2, 3027 SIJOUMI");
    // "Immatricul. = VIDE" / "Construct = VIDE" / "Chauffeur = VIDE" :
    // séparateur "=" reconnu, "VIDE" → null (jamais inventé).
    expect(s.truckRegistration).toBeNull();
    expect(s.truckManufacturer).toBeNull();
    expect(s.driverName).toBeNull();
    expect(s.deliveryAddress).toBe("sokra\nsokra"); // répétée sur 2 lignes, jointes par "\n" (préserve la structure visuelle)

    expect(s.items).toHaveLength(1);
    const item = s.items[0];
    expect(item.reference).toBe("00100001"); // pas confondu avec le "Référence: VIDE" du document
    expect(item.designation).toBe("PROMECHE EN FIBRE DE VERRE FINI");
    expect(item.unit).toBe("M2");
    expect(item.diameter).toBe("08");
    expect(item.meshSize).toBe("20X20");
    expect(Number(item.quantity)).toBeCloseTo(79.2, 2);
    expect(Number(s.totalQuantity)).toBeCloseTo(79.2, 2);

    // Vérification directe PostgreSQL — pas seulement la réponse API — puis
    // relecture via GET (simule un refresh complet de la page).
    const dbShipment = await FinanceShipment.findByPk(s.id);
    expect(dbShipment.customerCode).toBe("C1745741E");
    expect(dbShipment.customerHeadOfficeAddress).toBe("IMM LA PERLA 2, 3027 SIJOUMI");

    const reload = await request(app).get(`/finance/shipments/${s.id}`).set("Authorization", `Bearer ${token}`);
    expect(reload.status).toBe(200);
    expect(reload.body.data.customerName).toBe("STE MK BID SOFT");
    expect(reload.body.data.items).toHaveLength(1);

    createdShipmentIds.push(s.id);
  });

  // "Tester avec au moins 3 autres bons de livraison pour vérifier que le
  // parser ne dépend pas uniquement de ce document" (§TEST) — 3 mises en
  // page distinctes du document principal.

  test("'New shipment' — Doc B : bloc 'Adresse siège' + vrai téléphone (pas VIDE) + tableau bordé à 2 lignes", async () => {
    const pdf = await buildAdresseSiegeTabularDeliveryNotePdf({ deliveryNumber: `DOC-B-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `DOC-B-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    expect(s.reference).toBe(`DOC-B-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2025-03-10");
    expect(s.customerPhone).toBe("71 555 666"); // vrai numéro : le lookbehind CLIENT ne doit pas l'empêcher d'être extrait
    expect(s.customerTaxId).toBe("987654Z");
    expect(s.customerCode).toBe("C987654Z");
    // Le nom vient du bloc (pas de libellé "Nom client" séparé) — ne doit
    // JAMAIS devenir "71 555 666" ni "987654Z" (1re occurrence de "client").
    expect(s.customerName).toBe("STE DELTA CONSTRUCTION");
    expect(s.customerHeadOfficeAddress).toBe("RUE DE LA LIBERTE, 2000 BIZERTE");
    expect(s.deliveryAddress).toContain("Zone Franche Bizerte");

    expect(s.items).toHaveLength(2);
    const [item1, item2] = s.items;
    expect(item1.reference).toBe("00300003");
    expect(item1.designation).toBe("PANNEAU ISOLANT");
    expect(item1.meshSize).toBe("100X100");
    expect(Number(item1.quantity)).toBeCloseTo(50, 2);
    expect(item2.reference).toBe("00400004");
    expect(item2.designation).toBe("TREILLIS ACIER");
    expect(item2.meshSize).toBe("150X150");
    expect(Number(item2.quantity)).toBeCloseTo(25.5, 2);
    expect(Number(s.totalQuantity)).toBeCloseTo(75.5, 2);

    createdShipmentIds.push(s.id);
  });

  test("'New shipment' — Doc C : sans bloc 'Adresse siège' (libellé 'Nom client' classique), VIDE mélangé à de vraies valeurs", async () => {
    const pdf = await buildClassicMixedVideDeliveryNotePdf({ deliveryNumber: `DOC-C-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `DOC-C-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    expect(s.reference).toBe(`DOC-C-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2025-11-22");
    expect(s.customerPhone).toBeNull(); // VIDE
    expect(s.customerName).toBe("STE GAMMA DISTRIBUTION"); // libellé "Nom client" direct, pas de bloc "Adresse siège"
    expect(s.customerAddress).toBe("Route de Sfax Km 5");
    expect(s.customerGovernorate).toBe("Sfax"); // un des 24 gouvernorats officiels
    expect(s.customerTaxId).toBe("456789K");
    expect(s.customerCode).toBeNull(); // pas de bloc "Adresse siège" sur ce document
    expect(s.customerHeadOfficeAddress).toBeNull();
    expect(s.truckRegistration).toBe("789 TUN 1234");
    expect(s.truckManufacturer).toBe("IVECO");
    expect(s.driverName).toBeNull(); // VIDE
    expect(s.deliveryAddress).toBe("Depot Central Sfax");

    expect(s.items).toHaveLength(1);
    const item = s.items[0];
    expect(item.reference).toBe("00500005");
    expect(item.designation).toBe("GRILLAGE PLASTIFIE");
    expect(item.unit).toBe("ML");
    expect(item.diameter == null).toBe(true); // "Diam.: VIDE" → jamais inventé
    expect(item.meshSize).toBe("50X50");
    expect(Number(item.quantity)).toBeCloseTo(1250, 2);
    expect(Number(s.totalQuantity)).toBeCloseTo(1250, 2);

    createdShipmentIds.push(s.id);
  });

  test("'New shipment' — Doc D : bloc 'Adresse siège' sur 3 lignes d'adresse + section Expédition en '=' avec de vraies valeurs", async () => {
    const pdf = await buildAdresseSiegeLongAddressDeliveryNotePdf({ deliveryNumber: `DOC-D-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `DOC-D-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    expect(s.reference).toBe(`DOC-D-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2024-01-05");
    expect(s.customerTaxId).toBe("112233X");
    expect(s.customerCode).toBe("C112233X");
    expect(s.customerName).toBe("STE EPSILON TRAVAUX");
    expect(s.customerHeadOfficeAddress).toBe("7 AVENUE HABIB BOURGUIBA, RESIDENCE LES JASMINS, 4000 SOUSSE");
    // Séparateur "=" avec de VRAIES valeurs (pas VIDE) — doivent être extraites.
    expect(s.truckRegistration).toBe("456 TUN 7890");
    expect(s.truckManufacturer).toBe("RENAULT");
    expect(s.driverName).toBe("Mohamed Trabelsi");
    expect(s.deliveryAddress).toContain("Chantier Sud Sousse");

    expect(s.items).toHaveLength(2);
    const [item1, item2] = s.items;
    expect(item1.reference).toBe("00600006");
    expect(item1.designation).toBe("FIBRE DE VERRE TYPE A");
    expect(item1.meshSize).toBe("100X100");
    expect(Number(item1.quantity)).toBeCloseTo(300, 2);
    expect(item2.reference).toBe("00700007");
    expect(item2.designation).toBe("FIBRE DE VERRE TYPE B");
    expect(item2.meshSize).toBe("150X150");
    expect(Number(item2.quantity)).toBeCloseTo(200, 2);
    expect(Number(s.totalQuantity)).toBeCloseTo(500, 2);

    createdShipmentIds.push(s.id);
  });

  test("'New shipment' avec le Bon de Livraison EXACT de la spec (§CORRECTION MAJEURE) — tableau produits en texte empilé à 2 lignes, labels sans ':'", async () => {
    const pdf = await buildFlatColumnTableDeliveryNotePdf({ deliveryNumber: `BLL260088-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `BLL-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const s = res.body.data;

    expect(s.reference).toBe(`BLL260088-${RUN_ID}`);
    expect(s.shipmentDate).toBe("2026-03-10");
    expect(s.customerReference).toBeNull();
    expect(s.customerPhone).toBeNull();
    expect(s.customerTaxId).toBe("1646965S");
    expect(s.customerCode).toBe("C1646965S");
    expect(s.customerName).toBe("STE WW DISPLAY");
    expect(s.customerHeadOfficeAddress).toBe("TUNIS");
    expect(s.customerGovernorate).toBe("Tunis");
    expect(s.truckRegistration).toBeNull();
    expect(s.truckManufacturer).toBeNull();
    expect(s.driverName).toBeNull();
    expect(s.deliveryAddress).toBe("STE WW DISPLAY\nTUNIS\nTunisie");

    // Le tableau produits en texte empilé (pas de bordures) doit produire
    // AUTANT de lignes que le document en contient réellement — jamais un
    // nombre fixe supposé à l'avance.
    expect(s.items).toHaveLength(2);
    const [item1, item2] = s.items;
    expect(item1.reference).toBe("00200001");
    expect(item1.designation).toBe("PROBAR EN ARMATURE SF");
    expect(item1.unit).toBe("ML");
    expect(item1.diameter).toBe("06");
    expect(item1.meshSize == null).toBe(true); // "VIDE" → jamais inventé
    expect(Number(item1.quantity)).toBeCloseTo(1250, 2);
    expect(item2.reference).toBe("00200001"); // même référence que la ligne 1 — jamais mélangées
    expect(item2.designation).toBe("PROBAR EN ARMATURE SF");
    expect(item2.diameter).toBe("05"); // distinct de la ligne 1 (06)
    expect(item2.meshSize == null).toBe(true);
    expect(Number(item2.quantity)).toBeCloseTo(3230, 2);
    expect(Number(s.totalQuantity)).toBeCloseTo(4480, 2); // 1250 + 3230, cohérent avec le TOTAL du document

    // F5 / refresh complet : les données doivent venir de PostgreSQL, pas
    // seulement de l'état en mémoire du 1er appel.
    const dbShipment = await FinanceShipment.findByPk(s.id);
    expect(dbShipment.customerCode).toBe("C1646965S");
    const reload = await request(app).get(`/finance/shipments/${s.id}`).set("Authorization", `Bearer ${token}`);
    expect(reload.status).toBe(200);
    expect(reload.body.data.items).toHaveLength(2);

    createdShipmentIds.push(s.id);
  });

  test("'New shipment' sans document → 400 (jamais de Shipment sans document)", async () => {
    const res = await request(app).post("/finance/shipments").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("consultation puis modification du shipment", async () => {
    const view = await request(app).get(`/finance/shipments/${createdShipmentId}`).set("Authorization", `Bearer ${token}`);
    expect(view.status).toBe(200);
    expect(view.body.data.id).toBe(createdShipmentId);

    const update = await request(app)
      .put(`/finance/shipments/${createdShipmentId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "SHIPPED" });
    expect(update.status).toBe(200);
    expect(update.body.data.status).toBe("SHIPPED");
  });

  // ── Invoices / Payments ─────────────────────────────────────────────────

  test("création d'une facture à partir du shipment", async () => {
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        invoiceNumber: `INV-${RUN_ID}`,
        shipmentId: createdShipmentId,
        customerId,
        invoiceDate: "2026-08-11",
        amount: 1500,
        tax: 285,
      });

    expect(res.status).toBe(201);
    // Colonnes DECIMAL Postgres/Sequelize → renvoyées en string (évite toute
    // perte de précision flottante), jamais un number brut — comportement
    // Postgres standard, pas un bug.
    expect(Number(res.body.data.total)).toBeCloseTo(1785, 2);
    // Le statut n'est plus exposé dans la réponse API (§SUPPRESSION STATUT
    // FACTURE) — vérification directe en base pour confirmer que la logique
    // métier (statut initial ISSUED) reste correcte côté serveur.
    createdInvoiceId = res.body.data.id;
    const dbInvoice = await FinanceInvoice.findByPk(createdInvoiceId);
    expect(dbInvoice.status).toBe("ISSUED");
  });

  test("facture sans customerId/invoiceDate/amount ET sans document → 400 (flux JSON historique inchangé)", async () => {
    const res = await request(app).post("/finance/invoices").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  // "Upload invoice" simplifié (page Factured shipments) : le modal ne
  // contient que "Supporting documents" — la facture doit être LUE (OCR/
  // texte PDF), pas créée vide. `data` est désormais un TABLEAU (1 fichier =
  // 1 facture indépendamment traitée, confirmé avec l'utilisateur).
  test("'Upload invoice' avec une vraie facture PDF → données réellement extraites (numéro, date, client, lignes, totaux)", async () => {
    const pdf = await buildSyntheticInvoicePdf({ invoiceNumber: `FVL-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Invoice-GIQSYKRL-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    const inv = res.body.data[0];

    // Jamais une simple détection du nom de fichier : les valeurs viennent
    // du CONTENU du PDF, distinctes du nom de fichier utilisé ci-dessus.
    expect(inv.invoiceNumber).toBe(`FVL-${RUN_ID}`);
    expect(inv.invoiceDate).toBe("2026-08-14");
    expect(inv.customerName).toBe("STE ABC INDUSTRIE SARL");
    expect(inv.customerPhone).toBeTruthy();
    expect(inv.customerGovernorate).toBe("Ariana");
    expect(inv.customerTaxId).toContain("123456A");
    expect(inv.reference).toBe(`CMD-${RUN_ID}`);
    expect(Number(inv.amount)).toBeCloseTo(31250, 1);
    expect(Number(inv.tax)).toBeCloseTo(5937.5, 1);
    expect(Number(inv.total)).toBeCloseTo(37187.5, 1);
    // Le statut ("EXTRACTED") n'est plus exposé dans la réponse API
    // (§SUPPRESSION STATUT FACTURE) — vérifié directement en base plus bas.
    expect(inv.customerCode).toBeNull(); // pas de libellé "C MF" sur ce document
    expect(inv.documents).toHaveLength(1);

    expect(inv.items.length).toBeGreaterThanOrEqual(1);
    const item = inv.items[0];
    expect(item.reference).toBe("00100001");
    expect(Number(item.quantity)).toBe(2500);
    expect(item.diameter).toBe("6");
    expect(item.meshSize).toBe("100X100");
    expect(item.unit).toBe("M2");

    createdInvoiceIds.push(inv.id);

    const list = await request(app).get("/finance/invoices").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const found = list.body.data.find((i) => i.id === inv.id);
    expect(found).toBeTruthy();
    expect(found.customerName).toBe("STE ABC INDUSTRIE SARL");
    expect(found.documents).toHaveLength(1);

    // Vérification directe PostgreSQL (pas seulement la réponse API) —
    // confirme que la ligne existe réellement en base, pas juste en mémoire.
    const dbInvoice = await FinanceInvoice.findByPk(inv.id);
    expect(dbInvoice.customerName).toBe("STE ABC INDUSTRIE SARL");
    expect(dbInvoice.status).toBe("EXTRACTED");
    const dbItems = await FinanceInvoiceItem.findAll({ where: { invoiceId: inv.id } });
    expect(dbItems).toHaveLength(1);
    expect(Number(dbItems[0].quantity)).toBe(2500);
  });

  test("'Upload invoice' avec la facture EXACTE de la spec (§TEST OBLIGATOIRE) → tous les champs extraits correctement", async () => {
    const pdf = await buildExampleInvoicePdf();
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Facture-exemple-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];

    expect(inv.invoiceNumber).toBe(`FVL260103-${RUN_ID}`);
    expect(inv.invoiceDate).toBe("2026-08-11"); // "11/08/26" → année 2 chiffres
    expect(inv.customerCode).toBe("C1836134R"); // "C MF" — code brut, avec le préfixe "C"
    expect(inv.customerTaxId).toBe("1836134R"); // dérivé du code, préfixe "C" retiré
    expect(inv.customerName).toBe("STE 3M BUILDING SOLUTI"); // "Nom client:", pas confondu avec "C MF"
    expect(inv.customerAddress).toContain("LOT AFH LOT 159 AIN ZAGHOUAN");
    // Pas de "Référence" au niveau document sur cette facture — ne doit pas
    // être confondue avec la cellule d'en-tête "Ref" du tableau produits.
    expect(inv.reference).toBeNull();

    expect(inv.items).toHaveLength(1);
    const item = inv.items[0];
    expect(item.reference).toBe("00100001");
    expect(item.designation).toBe("PROMECHE EN FIBRE DE VERRE FINI");
    expect(item.unit).toBe("M2");
    expect(item.diameter).toBe("08");
    expect(item.meshSize).toBe("20X20");
    expect(Number(item.quantity)).toBeCloseTo(105.6, 2); // "105,6000" → 105.6
    expect(Number(item.unitPriceHT)).toBeCloseTo(10.4, 2); // "10,4000" → 10.4
    expect(Number(item.amountHT)).toBeCloseTo(1098.24, 2); // "1 098,240" → 1098.240
    expect(Number(item.tax1)).toBeCloseTo(1, 2);
    expect(Number(item.tax2)).toBeCloseTo(19, 2);

    createdInvoiceIds.push(inv.id);
    // Statut non exposé par l'API (§SUPPRESSION STATUT FACTURE) — vérifié en base.
    const dbInvoice = await FinanceInvoice.findByPk(inv.id);
    expect(dbInvoice.status).toBe("EXTRACTED");
  });

  test("'Upload invoice' avec la facture EXACTE de la spec (§CORRECTION DÉFINITIVE — FVL260080) → bloc client SANS libellé, totaux du bloc commercial (pas du bloc fiscal)", async () => {
    const pdf = await buildSageStyleInvoicePdf({ invoiceNumber: `FVL260080-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Facture-sage-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];

    expect(inv.invoiceNumber).toBe(`FVL260080-${RUN_ID}`);
    expect(inv.invoiceDate).toBe("2026-06-26");
    // Bloc client SANS aucun libellé adjacent (juste le code/nom/adresse
    // empilés, repérés par la FORME du code "C1219489FP") — jamais confondu
    // avec un libellé ("Matricule Fiscal client", "Numéro"...).
    expect(inv.customerCode).toBe("C1219489FP");
    expect(inv.customerName).toBe("LES ASTRES PROMOTION");
    expect(inv.customerAddress).toBe("IMM BADR 7EME ETAGE A72 KHEZEMA OUEST 4071 SOUSSE");
    expect(inv.customerGovernorate).toBe("Sousse");
    // "Matricule Fiscal client" — libellé séparé, PAS dérivé du code ici
    // (les deux coïncident numériquement mais la source est bien le libellé).
    expect(inv.customerTaxId).toBe("1219489FP");
    expect(inv.customerPhone).toBeNull(); // case vide sur ce document
    expect(inv.reference).toBeNull(); // case vide sur ce document

    // Totaux du bloc COMMERCIAL (Total HT/Total TTC), jamais de la colonne
    // "Base" ni de la ligne "Total" du bloc FISCAL voisin (16 168,118).
    expect(Number(inv.amount)).toBeCloseTo(8043.84, 2);
    expect(Number(inv.tax)).toBeCloseTo(1625.051, 2);
    expect(Number(inv.total)).toBeCloseTo(9668.891, 2);

    expect(inv.items).toHaveLength(1);
    const item = inv.items[0];
    expect(item.reference).toBe("00100001");
    expect(item.designation).toBe("PROMECHE EN FIBRE DE VERRE FINI");
    expect(item.unit).toBe("M²");
    expect(item.diameter).toBe("04");
    expect(item.meshSize).toBe("15X15");
    expect(Number(item.quantity)).toBeCloseTo(2116.8, 2);
    expect(Number(item.unitPriceHT)).toBeCloseTo(3.8, 2);
    expect(Number(item.amountHT)).toBeCloseTo(8043.84, 2);
    expect(Number(item.tax1)).toBeCloseTo(1, 2);
    expect(Number(item.tax2)).toBeCloseTo(19, 2);

    // Détail des taxes (§STRUCTURE DES TAXES) — nombre de lignes DYNAMIQUE
    // (3 ici, jamais supposé à 2), TFV sans taux ni montant imprimés → null,
    // jamais 0 ni inventé.
    expect(inv.taxes).toHaveLength(3);
    const [tax1, tax2, tax3] = inv.taxes;
    expect(tax1.code).toBe("F1V");
    expect(Number(tax1.base)).toBeCloseTo(8043.84, 2);
    expect(Number(tax1.rate)).toBeCloseTo(1, 2);
    expect(Number(tax1.amount)).toBeCloseTo(80.438, 3);
    expect(tax2.code).toBe("C19");
    expect(Number(tax2.base)).toBeCloseTo(8124.278, 3);
    expect(Number(tax2.rate)).toBeCloseTo(19, 2);
    expect(Number(tax2.amount)).toBeCloseTo(1543.613, 3);
    expect(tax3.code).toBe("TFV");
    expect(Number(tax3.base)).toBeCloseTo(0, 3);
    expect(tax3.rate).toBeNull();
    expect(tax3.amount).toBeNull();

    // Conditions de règlement / date / mode (§9-13) — la date de règlement
    // vient de la condition elle-même ("le 23/07/26"), jamais confondue avec
    // la date de facture (26/06/26) ni une autre date du document.
    expect(inv.paymentCondition).toBe("le 23/07/26");
    expect(inv.paymentDate).toBe("2026-07-23");
    expect(inv.paymentMethod).toBe("Traite");

    // Montant en toutes lettres — extrait verbatim.
    expect(inv.amountInWords).toBe("Neuf mille six cent soixante-huit dinars et huit cent quatre-vingt onze millimes");

    createdInvoiceIds.push(inv.id);
    const dbInvoice = await FinanceInvoice.findByPk(inv.id);
    expect(dbInvoice.status).toBe("EXTRACTED");
  });

  test("'Upload invoice' même mise en page Sage, DEUX lignes produit (diamètres/mailles/quantités différents, une ligne sans maille/remise) → aucune ligne fusionnée ni fantôme", async () => {
    const pdf = await buildSageStyleMultiItemInvoicePdf({ invoiceNumber: `FVL260099-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Facture-sage-multi-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];

    expect(inv.invoiceNumber).toBe(`FVL260099-${RUN_ID}`);
    expect(inv.invoiceDate).toBe("2026-09-02");
    expect(inv.customerCode).toBe("C0456789Q");
    expect(inv.customerName).toBe("STE GAFSA PHOSPHATE");
    expect(inv.customerTaxId).toBe("0456789Q");
    expect(inv.customerPhone).toBe("71 999 888");
    expect(inv.customerGovernorate).toBe("Gabes");

    // Totaux du bloc commercial — Total TTC (4 608,930) distinct de NET A
    // PAYER (4 108,930, après Acompte) : preuve qu'aucune confusion entre
    // les deux cellules voisines.
    expect(Number(inv.amount)).toBeCloseTo(3873.05, 2);
    expect(Number(inv.tax)).toBeCloseTo(735.88, 2);
    expect(Number(inv.total)).toBeCloseTo(4608.93, 2);

    expect(inv.items).toHaveLength(2);
    const [item1, item2] = inv.items;
    expect(item1.reference).toBe("00300003");
    expect(item1.designation).toBe("PROBAR EN ARMATURE SF");
    expect(item1.diameter).toBe("10");
    expect(item1.meshSize).toBeFalsy(); // pas de maille imprimée sur cette ligne
    expect(Number(item1.quantity)).toBeCloseTo(500, 2);
    expect(Number(item1.amountHT)).toBeCloseTo(2600, 2);

    expect(item2.reference).toBe("00100001");
    expect(item2.designation).toBe("PROMECHE EN FIBRE DE VERRE FINI");
    expect(item2.diameter).toBe("06");
    expect(item2.meshSize).toBe("10X10");
    expect(Number(item2.quantity)).toBeCloseTo(310.5, 2);
    expect(Number(item2.amountHT)).toBeCloseTo(1273.05, 2);

    createdInvoiceIds.push(inv.id);
  });

  test("'Upload invoice' facture SANS bloc fiscal (Total HT / TVA / NET À PAYER à plat, §11-12) → totaux réellement extraits, mode de paiement canonicalisé en 'Traite'", async () => {
    const pdf = await buildFlatTotalsInvoicePdf({ invoiceNumber: `FVL260096-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Facture-flat-totals-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];

    // Sans libellé "TVA" dédié dans l'extraction positionnelle, ces valeurs
    // resteraient à tort à 0 malgré leur présence réelle sur le document —
    // exactement l'exigence du ticket : "Ne pas mettre les valeurs à zéro
    // lorsque les montants sont présents dans le document."
    // finance_invoices.{amount,tax,total} sont DECIMAL(14,2) (2 décimales,
    // pas 3) — précision alignée sur la colonne réelle, pas sur les valeurs
    // sources à 3 décimales du document.
    expect(Number(inv.amount)).toBeCloseTo(16741.28, 2);
    expect(Number(inv.tax)).toBeCloseTo(3381.07, 2);
    expect(Number(inv.total)).toBeCloseTo(20122.35, 2); // = NET À PAYER, aucun "Total TTC" imprimé

    // Mode de paiement normalisé EXACTEMENT vers l'une des 4 valeurs du
    // dropdown (§3) — jamais "Total HT"/"client"/"Numéro" ou une autre
    // valeur voisine dans le texte brut.
    expect(inv.paymentMethod).toBe("Traite");
    expect(inv.paymentDate).toBe("2026-07-23");

    createdInvoiceIds.push(inv.id);
  });

  test("'Upload invoice' avec deux documents en un seul envoi → deux Invoices distinctes (1 fichier = 1 facture)", async () => {
    const pdfA = await buildSyntheticInvoicePdf({ invoiceNumber: `FVL-A-${RUN_ID}` });
    const pdfB = await buildSyntheticInvoicePdf({ invoiceNumber: `FVL-B-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdfA, { filename: `Invoice-A-${RUN_ID}.pdf`, contentType: "application/pdf" })
      .attach("documents", pdfB, { filename: `Invoice-B-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    const numbers = res.body.data.map((i) => i.invoiceNumber).sort();
    expect(numbers).toEqual([`FVL-A-${RUN_ID}`, `FVL-B-${RUN_ID}`].sort());
    res.body.data.forEach((i) => createdInvoiceIds.push(i.id));

    const list = await request(app).get("/finance/invoices").set("Authorization", `Bearer ${token}`);
    expect(list.body.count).toBeGreaterThanOrEqual(2);
  });

  // §CORRECTION PRIORITAIRE — EXTRACTION OCR FACTURE NADEC (§15 TEST OBLIGATOIRE).
  test("'Upload invoice' avec la facture NADEC EXACTE de la spec → invoiceFormat=NADEC, tous les champs extraits correctement, aucune annotation manuscrite dans le résultat", async () => {
    // "26/000016" est la valeur métier EXACTE de la spec (§15) — suffixée
    // par RUN_ID uniquement pour l'unicité DB entre exécutions successives
    // du fichier de test (même convention que toutes les autres factures de
    // ce fichier, ex. buildSageStyleInvoicePdf) ; assertion ci-dessous sur
    // le préfixe exact, jamais sur une valeur approximative.
    const invoiceNumber = `26/000016-${RUN_ID}`;
    const pdf = await buildNADECInvoicePdf({ invoiceNumber });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Facture-NADEC-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];

    expect(inv.format).toBe("NADEC");
    expect(inv.invoiceNumber).toBe(invoiceNumber);
    expect(inv.invoiceDate).toBe("2026-01-05");

    // Bloc "Client" (= CBIF, l'acheteur) — nom complet + sigle fusionnés par
    // un ESPACE, code/identifiant client ET Code TVA DISTINCTS (§15) —
    // jamais rempli avec le nom/l'adresse du FOURNISSEUR.
    expect(inv.customerName).toBe("COMPOSITE BUILDING INNOVATION FIRST CBIF");
    expect(inv.customerAddress).toBe("RUE 42500 EL HRAIRIA, 2051 TUNIS TUNISIE");
    expect(inv.customerCode).toBe("41112686");
    expect(inv.customerTaxId).toBe("1567517E/A/M/000");

    // Bloc fournisseur — objet DISTINCT (name/shortName séparés), jamais
    // fusionné avec customer*.
    expect(inv.supplier).toBeTruthy();
    expect(inv.supplier.name.value).toBe("NORD AFRICAINE DES ECHANGES COMMERCIAUX");
    expect(inv.supplier.shortName.value).toBe("NADEC");
    expect(inv.supplier.address.value).toBe("ZI SIDI REZIG, 2 RUE DU PLASTIQUE, 2033 MEGRINE TUNISIE");
    expect(inv.supplier.phone.value).toBe("71 426 346");
    expect(inv.supplier.taxId.value).toBe("0031422Q/A/M/000");

    // BL N°/BC N° — BC N° explicitement "vide" sur le document → `null`,
    // jamais une chaîne vide ou une valeur devinée.
    expect(inv.references).toBeTruthy();
    expect(inv.references.blNumber.value).toBe("26/000021");
    expect(inv.references.bcNumber.value).toBeNull();

    // Opérateur/Vendeur/Page — champs propres au format NADEC.
    expect(inv.operator.value).toBe("NAWEL");
    expect(inv.seller.value).toBe("NADEC");
    expect(inv.page.value).toBe("1/1");

    // Totaux — valeurs EXACTES de la spec (§3), jamais recalculées.
    expect(Number(inv.amount)).toBeCloseTo(21280.0, 2); // Total HT
    expect(Number(inv.tax)).toBeCloseTo(4043.2, 2); // Montant Taxe(s)
    expect(Number(inv.total)).toBeCloseTo(25324.2, 2); // Total TTC

    // Zone Taxes séparée (§4) — jamais confondue avec Total HT/Total TTC/
    // Timbre fiscal voisins.
    expect(inv.taxesZone).toBeTruthy();
    expect(Number(inv.taxesZone.taxRate.value)).toBeCloseTo(19, 2);
    expect(Number(inv.taxesZone.taxableBase.value)).toBeCloseTo(21280, 2);
    expect(Number(inv.taxesZone.taxAmount.value)).toBeCloseTo(4043.2, 2);

    // Zone Règlement (§5) — aucune valeur imprimée sur ce document → `null`,
    // jamais "Traite"/"Chèque"/"Espèce" inventé.
    expect(inv.paymentMethod).toBeNull();

    // §12 VALIDATION : Σ items.amountHT ≈ Total HT, Total HT+TVA+Timbre ≈
    // Total TTC — déjà vérifié structurellement par les totaux ci-dessus
    // (21280+4043.2+1=25324.2, exactement la valeur imprimée).

    // Les 3 lignes EXACTES (§2), références conservées telles quelles (§8),
    // AUCUNE annotation manuscrite ("Resine"/"ISO", §9-10) dans le résultat.
    expect(inv.items).toHaveLength(3);
    const [item1, item2, item3] = inv.items;
    expect(item1.reference).toBe("PEINTU.PE-ALK/0149");
    expect(item1.designation).toBe("EPOXY LAPOX AR-101 FUT 240 KG");
    expect(item1.unit).toBe("KG");
    expect(Number(item1.quantity)).toBeCloseTo(960, 2);
    expect(Number(item1.unitPriceHT)).toBeCloseTo(9.5, 2);
    expect(Number(item1.amountHT)).toBeCloseTo(9120, 2);

    expect(item2.reference).toBe("PEINTU.PE-ALK/0040");
    expect(item2.designation).toBe("EPOXY LAPOX AH-112 FUT 200 KG");
    expect(Number(item2.quantity)).toBeCloseTo(800, 2);
    expect(Number(item2.unitPriceHT)).toBeCloseTo(14.5, 2);
    expect(Number(item2.amountHT)).toBeCloseTo(11600, 2);

    expect(item3.reference).toBe("PEINTU.PE-ALK/0433");
    expect(item3.designation).toBe("DILUANT EL 039 FUT 200 L");
    expect(item3.unit).toBe("LITRE");
    expect(Number(item3.quantity)).toBeCloseTo(200, 2);
    expect(Number(item3.unitPriceHT)).toBeCloseTo(2.8, 2);
    expect(Number(item3.amountHT)).toBeCloseTo(560, 2);

    const allText = JSON.stringify(inv.items) + inv.customerName + inv.supplier.name.value;
    expect(allText).not.toMatch(/Resine/i);
    expect(allText).not.toMatch(/\bISO\b/);

    createdInvoiceIds.push(inv.id);
  });

  test("'Upload invoice' facture SAGE (format 1) après une facture NADEC → détection toujours correcte, aucune régression croisée entre les deux formats", async () => {
    const pdf = await buildSageStyleInvoicePdf({ invoiceNumber: `FVL260080-REGR-${RUN_ID}` });
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `Facture-sage-regr-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];
    expect(inv.format).toBe("SAGE");
    expect(inv.customerName).toBe("LES ASTRES PROMOTION");
    expect(inv.customerCode).toBe("C1219489FP");
    // Le format SAGE n'a ni bloc fournisseur ni BL N°/BC N° — jamais inventés.
    expect(inv.supplier).toBeNull();
    expect(inv.references).toBeNull();

    createdInvoiceIds.push(inv.id);
  });

  test("detectInvoiceFormat — plusieurs indices, jamais un seul mot isolé, UNKNOWN si aucun indice", () => {
    const sageText = "FACTURE\nConditions de règlement : le 23/07/26 Traite\nNET A PAYER 9 668,891\nAcompte 0,000\nTaxe1 Taxe2";
    const nadecText =
      "N° Facture 26/000016\nBL N° 26/000021\nBC N° vide\nAssiette 21 280,000\nMontant Taxe(s) 4 043,200\nTimbre Fiscal 1,000\nNORD AFRICAINE DES ECHANGES COMMERCIAUX NADEC";
    expect(detectInvoiceFormat(sageText)).toBe("SAGE");
    expect(detectInvoiceFormat(nadecText)).toBe("NADEC");
    // Aucun indice reconnaissable → UNKNOWN (jamais faussement "SAGE" par
    // défaut, §13) — le dispatcher applique quand même le moteur générique
    // en repli (voir extractInvoiceFields).
    expect(detectInvoiceFormat("")).toBe("UNKNOWN");
    expect(detectInvoiceFormat("texte quelconque sans rapport")).toBe("UNKNOWN");
  });

  test("'Upload invoice' avec un document totalement illisible → OCR_FAILED, jamais de valeur inventée", async () => {
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", Buffer.from("%PDF-1.4"), { filename: `illisible-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];
    expect(inv.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/); // clé interne auto-générée, jamais dérivée du nom de fichier
    expect(inv.invoiceNumber).not.toMatch(new RegExp(String(RUN_ID)));
    expect(inv.customerName).toBeNull(); // jamais deviné
    expect(inv.invoiceDate).toBeNull();
    expect(inv.items).toHaveLength(0);
    // Le document reste attaché même en cas d'échec total de l'OCR.
    expect(inv.documents).toHaveLength(1);
    createdInvoiceIds.push(inv.id);
    // Statut non exposé par l'API (§SUPPRESSION STATUT FACTURE) — vérifié en base.
    const dbInvoice = await FinanceInvoice.findByPk(inv.id);
    expect(dbInvoice.status).toBe("OCR_FAILED");
  });

  test("'Upload invoice' avec une image (PNG) → également lue par OCR", async () => {
    const invoicePdf = await buildSyntheticInvoicePdf({ invoiceNumber: `FVL-IMG-${RUN_ID}` });
    const pngBuffer = await renderPdfFirstPageToPng(invoicePdf);
    const res = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pngBuffer, { filename: `Invoice-scan-${RUN_ID}.png`, contentType: "image/png" });

    expect(res.status).toBe(201);
    const inv = res.body.data[0];
    // L'OCR image reste heuristique (contrairement au texte PDF natif) —
    // on vérifie que le pipeline a bien LU le document (statut cohérent,
    // facture réellement enregistrée), sans exiger une extraction parfaite
    // à 100% du tableau de lignes. Statut non exposé par l'API
    // (§SUPPRESSION STATUT FACTURE) — vérifié directement en base.
    expect(inv.documents).toHaveLength(1);
    createdInvoiceIds.push(inv.id);
    const dbInvoice = await FinanceInvoice.findByPk(inv.id);
    expect(["EXTRACTED", "NEEDS_REVIEW"]).toContain(dbInvoice.status);

    const check = await request(app).get(`/finance/invoices/${inv.id}`).set("Authorization", `Bearer ${token}`);
    expect(check.status).toBe(200);
  }, 30000);

  test("la facture apparaît dans GET /finance/invoices", async () => {
    const res = await request(app)
      .get("/finance/invoices")
      .query({ search: `INV-${RUN_ID}` })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((i) => i.id === createdInvoiceId)).toBe(true);
  });

  test("enregistrement d'un paiement (formulaire minimal : method + document uniquement) → statut PAID, visible dans /finance/paid-invoices", async () => {
    // Formulaire minimal (§MODIFIER LE WORKFLOW PAYMENT / PAID FACTURES,
    // §2) : ni amount ni paidDate envoyés par le client — le backend les
    // déduit (montant total de la facture, jamais une valeur partielle
    // devinée) et passe directement la facture en PAID (§6).
    const pay = await request(app)
      .post(`/finance/invoices/${createdInvoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .field("method", "Virement")
      .attach("document", Buffer.from("%PDF-1.4 fake virement receipt"), { filename: `virement-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(pay.status).toBe(201);
    // Statut non exposé par l'API (§SUPPRESSION STATUT FACTURE) — vérifié en
    // base, et confirmé indirectement par la présence dans /paid-invoices
    // (filtré côté serveur sur status="PAID").
    const dbInvoice = await FinanceInvoice.findByPk(createdInvoiceId);
    expect(dbInvoice.status).toBe("PAID");

    // "Virement" ne nécessite aucun champ spécifique Chèque/Traite — ils
    // doivent rester NULL, jamais laissés à une valeur par défaut. Le
    // justificatif est bien associé au paiement (§6 étape 3).
    const payment = pay.body.data.payments.find((p) => p.method === "Virement");
    expect(payment).toBeTruthy();
    expect(Number(payment.amount)).toBeCloseTo(1785, 2); // = invoice.total, déduit par le backend
    expect(payment.chequeNumber).toBeNull();
    expect(payment.bankName).toBeNull();
    expect(payment.chequeDate).toBeNull();
    expect(payment.billOfExchangeNumber).toBeNull();
    expect(payment.dueDate).toBeNull();
    expect(payment.documents).toHaveLength(1);

    const paidList = await request(app).get("/finance/paid-invoices").set("Authorization", `Bearer ${token}`);
    expect(paidList.status).toBe(200);
    expect(paidList.body.data.some((i) => i.id === createdInvoiceId)).toBe(true);

    // Factured Shipments (§8) : la facture désormais payée en est retirée.
    const facturedList = await request(app).get("/finance/invoices").set("Authorization", `Bearer ${token}`);
    expect(facturedList.status).toBe(200);
    expect(facturedList.body.data.some((i) => i.id === createdInvoiceId)).toBe(false);
  });

  test("Register payment sans justificatif → 400 (le justificatif est obligatoire, §6)", async () => {
    const invoiceRes = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceNumber: `INV-NODOC-${RUN_ID}`, customerId, invoiceDate: "2026-08-11", amount: 500, tax: 0 });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.body.data.id;

    const pay = await request(app)
      .post(`/finance/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .field("method", "Versement");
    expect(pay.status).toBe(400);
    expect(await FinancePayment.findAll({ where: { invoiceId } })).toHaveLength(0);

    await FinanceInvoice.destroy({ where: { id: invoiceId } });
  });

  test("Register payment — Chèque avec document justificatif → chequeNumber/bankName/chequeDate persistés, champs Traite NULL, document associé", async () => {
    const invoiceRes = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceNumber: `INV-CHEQUE-${RUN_ID}`, customerId, invoiceDate: "2026-08-11", amount: 1000, tax: 0 });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.body.data.id;

    const pay = await request(app)
      .post(`/finance/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .field("amount", "500")
      .field("paidDate", "2026-08-12")
      .field("method", "Chèque")
      .field("chequeNumber", "CHQ-00123")
      .field("bankName", "Banque de Tunisie")
      .field("chequeDate", "2026-08-10")
      .attach("document", Buffer.from("%PDF-1.4 fake cheque scan"), { filename: `cheque-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(pay.status).toBe(201);
    const payment = pay.body.data.payments.find((p) => p.method === "Chèque");
    expect(payment).toBeTruthy();
    expect(payment.chequeNumber).toBe("CHQ-00123");
    expect(payment.bankName).toBe("Banque de Tunisie");
    expect(payment.chequeDate).toBe("2026-08-10");
    // Champs spécifiques à la Traite — NULL pour un mode Chèque.
    expect(payment.billOfExchangeNumber).toBeNull();
    expect(payment.dueDate).toBeNull();
    expect(payment.documents).toHaveLength(1);
    expect(payment.documents[0].originalName).toContain("cheque");

    const dbInvoice = await FinanceInvoice.findByPk(invoiceId);
    expect(dbInvoice.status).toBe("PARTIALLY_PAID");

    // Nettoyage immédiat (facture annexe non couverte par afterAll).
    await FinanceActivity.destroy({ where: { entityId: [invoiceId, payment.id] } });
    await FinanceDocument.destroy({ where: { entityId: payment.id } });
    await FinancePayment.destroy({ where: { invoiceId } });
    await FinanceInvoice.destroy({ where: { id: invoiceId } });
  });

  test("Register payment — Traite avec document justificatif → billOfExchangeNumber/bankName/dueDate persistés, champs Chèque NULL, document associé", async () => {
    const invoiceRes = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceNumber: `INV-TRAITE-${RUN_ID}`, customerId, invoiceDate: "2026-08-11", amount: 1000, tax: 0 });
    expect(invoiceRes.status).toBe(201);
    const invoiceId = invoiceRes.body.data.id;

    const pay = await request(app)
      .post(`/finance/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .field("amount", "1000")
      .field("paidDate", "2026-08-12")
      .field("method", "Traite")
      .field("billOfExchangeNumber", "TR-00456")
      .field("bankName", "BIAT")
      .field("dueDate", "2026-11-12")
      .attach("document", Buffer.from("%PDF-1.4 fake traite scan"), { filename: `traite-${RUN_ID}.pdf`, contentType: "application/pdf" });

    expect(pay.status).toBe(201);
    const payment = pay.body.data.payments.find((p) => p.method === "Traite");
    expect(payment).toBeTruthy();
    expect(payment.billOfExchangeNumber).toBe("TR-00456");
    expect(payment.bankName).toBe("BIAT");
    expect(payment.dueDate).toBe("2026-11-12");
    // Champs spécifiques au Chèque — NULL pour un mode Traite.
    expect(payment.chequeNumber).toBeNull();
    expect(payment.chequeDate).toBeNull();
    expect(payment.documents).toHaveLength(1);
    expect(payment.documents[0].originalName).toContain("traite");

    const dbInvoice = await FinanceInvoice.findByPk(invoiceId);
    expect(dbInvoice.status).toBe("PAID"); // paiement = total de la facture

    // Nettoyage immédiat (facture annexe non couverte par afterAll).
    await FinanceActivity.destroy({ where: { entityId: [invoiceId, payment.id] } });
    await FinanceDocument.destroy({ where: { entityId: payment.id } });
    await FinancePayment.destroy({ where: { invoiceId } });
    await FinanceInvoice.destroy({ where: { id: invoiceId } });
  });

  test("paiement partiel → statut PARTIALLY_PAID (facture séparée)", async () => {
    const invoiceRes = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceNumber: `INV-PARTIAL-${RUN_ID}`, customerId, invoiceDate: "2026-08-11", amount: 1000, tax: 0 });
    expect(invoiceRes.status).toBe(201);
    const partialInvoiceId = invoiceRes.body.data.id;

    // `amount` explicite (400 < total 1000) reste supporté côté backend même
    // si le nouveau formulaire minimal ne le collecte plus — un appelant qui
    // le fournit explicitement doit toujours produire un paiement PARTIEL.
    const pay = await request(app)
      .post(`/finance/invoices/${partialInvoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .field("amount", "400")
      .field("paidDate", "2026-08-12")
      .field("method", "Versement")
      .attach("document", Buffer.from("%PDF-1.4 fake versement receipt"), { filename: `versement-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(pay.status).toBe(201);
    // Statut non exposé par l'API (§SUPPRESSION STATUT FACTURE) — vérifié en base.
    const dbInvoice = await FinanceInvoice.findByPk(partialInvoiceId);
    expect(dbInvoice.status).toBe("PARTIALLY_PAID");

    // Nettoyage immédiat (facture annexe non couverte par afterAll).
    await FinanceActivity.destroy({ where: { entityId: partialInvoiceId } });
    await FinancePayment.destroy({ where: { invoiceId: partialInvoiceId } });
    await FinanceInvoice.destroy({ where: { id: partialInvoiceId } });
  });

  // ── Suppression (§AJOUTER LA SUPPRESSION DES DOCUMENTS FINANCE) ────────
  // Chaque test est autonome (création + suppression + vérification), pas
  // couvert par les tableaux de nettoyage globaux — la suppression EST le
  // nettoyage.

  test("DELETE /finance/raw-materials/:id → bon de commande + lignes + document + fichier physique réellement supprimés", async () => {
    const pdf = await buildPurchaseOrderPdf({ orderNumber: `BCL-DEL-${RUN_ID}` });
    const upload = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdf, { filename: `bc-delete-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    const orderId = upload.body.data.id;
    const documentId = upload.body.data.documents[0].id;
    const storedFileName = upload.body.data.documents[0].fileUrl.split("/").pop();
    const filePath = path.join(UPLOAD_DIR, storedFileName);
    expect(fs.existsSync(filePath)).toBe(true);

    const itemsBefore = await FinancePurchaseOrderItem.findAll({ where: { purchaseOrderId: orderId } });
    expect(itemsBefore.length).toBeGreaterThan(0);

    const del = await request(app).delete(`/finance/raw-materials/${orderId}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true, message: "Purchase order deleted successfully" });

    expect(await FinancePurchaseOrder.findByPk(orderId)).toBeNull();
    expect(await FinancePurchaseOrderItem.findAll({ where: { purchaseOrderId: orderId } })).toHaveLength(0);
    expect(await FinanceDocument.findByPk(documentId)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);

    const afterDelete = await request(app).get(`/finance/raw-materials/${orderId}`).set("Authorization", `Bearer ${token}`);
    expect(afterDelete.status).toBe(404);
  });

  test("DELETE /finance/raw-materials/:id sur un bon inexistant → 404", async () => {
    const res = await request(app)
      .delete("/finance/raw-materials/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("DELETE /finance/shipments/:id → shipment + produits + document + fichier réellement supprimés, SANS supprimer une facture liée (shipmentId mis à NULL)", async () => {
    const pdf = await buildSyntheticDeliveryNotePdf({ deliveryNumber: `BL-DEL-${RUN_ID}` });
    const upload = await request(app)
      .post("/finance/shipments")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `bl-delete-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    const shipmentId = upload.body.data.id;
    const documentId = upload.body.data.documents[0].id;
    const storedFileName = upload.body.data.documents[0].fileUrl.split("/").pop();
    const filePath = path.join(UPLOAD_DIR, storedFileName);
    expect(fs.existsSync(filePath)).toBe(true);

    const itemsBefore = await FinanceShipmentItem.findAll({ where: { shipmentId } });
    expect(itemsBefore.length).toBeGreaterThan(0);

    // Facture liée à ce shipment — doit SURVIVRE à la suppression du
    // shipment (shipmentId mis à NULL, jamais supprimée elle-même).
    const invoiceRes = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ invoiceNumber: `INV-LINKED-${RUN_ID}`, shipmentId, customerId, invoiceDate: "2026-08-11", amount: 500, tax: 0 });
    expect(invoiceRes.status).toBe(201);
    const linkedInvoiceId = invoiceRes.body.data.id;

    const del = await request(app).delete(`/finance/shipments/${shipmentId}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true, message: "Shipment deleted successfully" });

    expect(await FinanceShipment.findByPk(shipmentId)).toBeNull();
    expect(await FinanceShipmentItem.findAll({ where: { shipmentId } })).toHaveLength(0);
    expect(await FinanceDocument.findByPk(documentId)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);

    const dbLinkedInvoice = await FinanceInvoice.findByPk(linkedInvoiceId);
    expect(dbLinkedInvoice).not.toBeNull();
    expect(dbLinkedInvoice.shipmentId).toBeNull();

    const afterDelete = await request(app).get(`/finance/shipments/${shipmentId}`).set("Authorization", `Bearer ${token}`);
    expect(afterDelete.status).toBe(404);

    // Nettoyage de la facture annexe créée pour ce test.
    await FinanceActivity.destroy({ where: { entityId: linkedInvoiceId } });
    await FinanceInvoice.destroy({ where: { id: linkedInvoiceId } });
  });

  test("DELETE /finance/shipments/:id sur un shipment inexistant → 404", async () => {
    const res = await request(app)
      .delete("/finance/shipments/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test("DELETE /finance/invoices/:id → invoice + lignes + paiements + document + fichier réellement supprimés", async () => {
    const pdf = await buildSyntheticInvoicePdf({ invoiceNumber: `FVL-DEL-${RUN_ID}` });
    const upload = await request(app)
      .post("/finance/invoices")
      .set("Authorization", `Bearer ${token}`)
      .attach("documents", pdf, { filename: `facture-delete-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    const invoiceId = upload.body.data[0].id;
    const documentId = upload.body.data[0].documents[0].id;
    const storedFileName = upload.body.data[0].documents[0].fileUrl.split("/").pop();
    const filePath = path.join(UPLOAD_DIR, storedFileName);
    expect(fs.existsSync(filePath)).toBe(true);

    const itemsBefore = await FinanceInvoiceItem.findAll({ where: { invoiceId } });
    expect(itemsBefore.length).toBeGreaterThan(0);

    await request(app)
      .post(`/finance/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .field("amount", "100")
      .field("paidDate", "2026-08-12")
      .field("method", "Virement")
      .attach("document", Buffer.from("%PDF-1.4 fake virement receipt"), { filename: `virement-del-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(await FinancePayment.findAll({ where: { invoiceId } })).toHaveLength(1);

    const del = await request(app).delete(`/finance/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ success: true, message: "Invoice deleted successfully" });

    expect(await FinanceInvoice.findByPk(invoiceId)).toBeNull();
    expect(await FinanceInvoiceItem.findAll({ where: { invoiceId } })).toHaveLength(0);
    expect(await FinancePayment.findAll({ where: { invoiceId } })).toHaveLength(0);
    expect(await FinanceDocument.findByPk(documentId)).toBeNull();
    expect(fs.existsSync(filePath)).toBe(false);

    const afterDelete = await request(app).get(`/finance/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`);
    expect(afterDelete.status).toBe(404);
  });

  test("DELETE /finance/invoices/:id sur une facture inexistante → 404", async () => {
    const res = await request(app)
      .delete("/finance/invoices/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // ── Finance Dashboard (§MODIFICATION — DASHBOARD FINANCE PROFESSIONNEL) ──
  // Placés en fin de suite pour profiter des données déjà créées par les
  // tests précédents (KPI non nuls, jamais des valeurs figées).

  test("GET /finance/dashboard → KPI calculés dynamiquement à partir des données réelles", async () => {
    const res = await request(app).get("/finance/dashboard").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const d = res.body.data;

    // Les bons/factures créés par les tests précédents de ce fichier
    // garantissent des compteurs strictement positifs — jamais un 0 figé.
    expect(d.purchaseOrders).toBeGreaterThan(0);
    expect(d.customerShipments).toBeGreaterThan(0);
    expect(d.invoices).toBeGreaterThan(0);
    expect(typeof d.paidInvoices).toBe("number");
    expect(typeof d.totalPurchases).toBe("number");
    expect(typeof d.totalInvoiced).toBe("number");
    expect(typeof d.totalPaid).toBe("number");
    // outstanding = max(0, totalInvoiced - totalPaid), jamais négatif.
    expect(d.outstanding).toBeCloseTo(Math.max(0, d.totalInvoiced - d.totalPaid), 2);
    expect(d.outstanding).toBeGreaterThanOrEqual(0);

    // Finance Alerts (§10) — uniquement des compteurs réels.
    expect(d.alerts).toBeTruthy();
    expect(typeof d.alerts.unpaidInvoices).toBe("number");
    expect(typeof d.alerts.newPurchaseOrdersThisWeek).toBe("number");
    expect(typeof d.alerts.newShipmentsThisWeek).toBe("number");
    expect(typeof d.alerts.recentDocumentsCount).toBe("number");
  });

  test("GET /finance/dashboard avec filtre customer → ne compte QUE les enregistrements de ce client", async () => {
    const uniqueCustomer = `DASHBOARD-TEST-CUSTOMER-${RUN_ID}`;
    const pdf = await buildPurchaseOrderPdf({
      orderNumber: `BCL-DASH-${RUN_ID}`,
      customerCode: `F${RUN_ID}`,
      customerName: uniqueCustomer,
    });
    const upload = await request(app)
      .post("/finance/raw-materials/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", pdf, { filename: `bon-dash-${RUN_ID}.pdf`, contentType: "application/pdf" });
    expect(upload.status).toBe(201);
    createdPurchaseOrderIds.push(upload.body.data.id);

    const res = await request(app)
      .get("/finance/dashboard")
      .query({ customer: uniqueCustomer })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.purchaseOrders).toBe(1);
    expect(Number(res.body.data.totalPurchases)).toBeCloseTo(Number(upload.body.data.totalHT), 2);
    // Aucun shipment/invoice n'a ce nom client — comptés à 0, jamais confondus.
    expect(res.body.data.customerShipments).toBe(0);
    expect(res.body.data.invoices).toBe(0);
  });

  test("GET /finance/dashboard/monthly → série mensuelle Purchase Orders/Invoices/Paid Invoices agrégée côté serveur", async () => {
    const res = await request(app).get("/finance/dashboard/monthly").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof row.purchaseOrders).toBe("number");
      expect(typeof row.invoices).toBe("number");
      expect(typeof row.paidInvoices).toBe("number");
    }
    // Au moins un mois doit refléter les Purchase Orders créés par ce
    // fichier de tests (jamais une série entièrement vide malgré les
    // données réelles présentes en base).
    const totalPurchaseOrdersAcrossMonths = res.body.data.reduce((s, r) => s + r.purchaseOrders, 0);
    expect(totalPurchaseOrdersAcrossMonths).toBeGreaterThan(0);
  });

  test("DELETE sans authentification → 401 (les 3 endpoints)", async () => {
    const results = await Promise.all([
      request(app).delete("/finance/raw-materials/00000000-0000-0000-0000-000000000000"),
      request(app).delete("/finance/shipments/00000000-0000-0000-0000-000000000000"),
      request(app).delete("/finance/invoices/00000000-0000-0000-0000-000000000000"),
    ]);
    results.forEach((res) => expect(res.status).toBe(401));
  });

  // §MODIFICATION — FINANCE > OTHER — SCAN SIMPLE DE DOCUMENTS.
  describe("Finance > Other (stockage documentaire pur, aucun OCR)", () => {
    let otherDocId;

    test("POST /finance/other-documents → document enregistré tel quel, displayName = originalName, AUCUN champ d'extraction", async () => {
      const res = await request(app)
        .post("/finance/other-documents")
        .set("Authorization", `Bearer ${token}`)
        .attach("file", Buffer.from("%PDF-1.4 contenu quelconque, jamais lu"), {
          filename: `scan-other-${RUN_ID}.pdf`,
          contentType: "application/pdf",
        });

      expect(res.status).toBe(201);
      const doc = res.body.data;
      otherDocId = doc.id;
      expect(doc.module).toBe("OTHER");
      expect(doc.originalName).toBe(`scan-other-${RUN_ID}.pdf`);
      // §6 : displayName = originalName au moment de l'upload.
      expect(doc.displayName).toBe(`scan-other-${RUN_ID}.pdf`);
      expect(doc.entityId).toBeNull();
      // §1/§14 : aucune extraction — le document ne porte AUCUN des champs
      // que produirait un pipeline OCR (numéro/client/date/montant/statut
      // d'extraction) : la réponse d'un document générique n'a jamais eu ces
      // clés, contrairement à toInvoiceResponse/toPurchaseOrderResponse/
      // toShipmentResponse (aucun champ "status"/"ocrConfidence" propre à un
      // pipeline d'extraction ici — seul "status" de validation PENDING du
      // document lui-même, sans rapport avec l'OCR, existe déjà par défaut).
      expect(doc).not.toHaveProperty("invoiceNumber");
      expect(doc).not.toHaveProperty("orderNumber");
      expect(doc).not.toHaveProperty("shipmentNumber");
      expect(doc).not.toHaveProperty("ocrConfidence");
    });

    test("GET /finance/other-documents → recherche par displayName/originalName/mimeType", async () => {
      const res = await request(app)
        .get("/finance/other-documents")
        .query({ search: `scan-other-${RUN_ID}` })
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.some((d) => d.id === otherDocId)).toBe(true);

      // Recherche par "type" (sous-chaîne du mimeType réel, §15).
      const byType = await request(app)
        .get("/finance/other-documents")
        .query({ search: "pdf" })
        .set("Authorization", `Bearer ${token}`);
      expect(byType.status).toBe(200);
      expect(byType.body.data.some((d) => d.id === otherDocId)).toBe(true);

      // Filtre "type" (§16) — PDF trouve le document, IMAGE ne le trouve pas.
      const filterPdf = await request(app)
        .get("/finance/other-documents")
        .query({ type: "PDF" })
        .set("Authorization", `Bearer ${token}`);
      expect(filterPdf.body.data.some((d) => d.id === otherDocId)).toBe(true);

      const filterImage = await request(app)
        .get("/finance/other-documents")
        .query({ type: "IMAGE" })
        .set("Authorization", `Bearer ${token}`);
      expect(filterImage.body.data.some((d) => d.id === otherDocId)).toBe(false);
    });

    test("PATCH /finance/other-documents/:id → renomme UNIQUEMENT displayName, originalName/fileUrl inchangés", async () => {
      const before = await request(app)
        .get("/finance/other-documents")
        .query({ search: `scan-other-${RUN_ID}` })
        .set("Authorization", `Bearer ${token}`);
      const originalFileUrl = before.body.data.find((d) => d.id === otherDocId).fileUrl;
      const originalName = before.body.data.find((d) => d.id === otherDocId).originalName;

      const res = await request(app)
        .patch(`/finance/other-documents/${otherDocId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ displayName: `Contrat fournisseur NADEC ${RUN_ID}.pdf` });

      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe(`Contrat fournisseur NADEC ${RUN_ID}.pdf`);
      expect(res.body.data.originalName).toBe(originalName); // jamais modifié
      expect(res.body.data.fileUrl).toBe(originalFileUrl); // jamais modifié

      // Persisté en base — pas seulement dans la réponse (§TEST 3 : après
      // refresh, le nouveau nom reste affiché).
      const after = await request(app)
        .get("/finance/other-documents")
        .query({ search: "Contrat fournisseur NADEC" })
        .set("Authorization", `Bearer ${token}`);
      expect(after.body.data.some((d) => d.id === otherDocId && d.displayName === `Contrat fournisseur NADEC ${RUN_ID}.pdf`)).toBe(true);
    });

    test("PATCH /finance/other-documents/:id avec un nom vide → 400, rien modifié", async () => {
      const res = await request(app)
        .patch(`/finance/other-documents/${otherDocId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ displayName: "   " });
      expect(res.status).toBe(400);
    });

    test("PATCH /finance/other-documents/:id sur un document inexistant → 404", async () => {
      const res = await request(app)
        .patch("/finance/other-documents/00000000-0000-0000-0000-000000000000")
        .set("Authorization", `Bearer ${token}`)
        .send({ displayName: "x" });
      expect(res.status).toBe(404);
    });

    test("DELETE /finance/other-documents/:id → supprimé de la DB et disparaît de la liste", async () => {
      const del = await request(app).delete(`/finance/other-documents/${otherDocId}`).set("Authorization", `Bearer ${token}`);
      expect(del.status).toBe(200);
      expect(del.body.success).toBe(true);

      const after = await request(app)
        .get("/finance/other-documents")
        .query({ search: "Contrat fournisseur NADEC" })
        .set("Authorization", `Bearer ${token}`);
      expect(after.body.data.some((d) => d.id === otherDocId)).toBe(false);

      // Deuxième suppression du même id → 404 (jamais un succès silencieux
      // sur un document déjà supprimé — couvre aussi le cas double-clic
      // niveau backend).
      const second = await request(app).delete(`/finance/other-documents/${otherDocId}`).set("Authorization", `Bearer ${token}`);
      expect(second.status).toBe(404);
    });

    test("POST/GET/PATCH/DELETE /finance/other-documents sans authentification → 401", async () => {
      const results = await Promise.all([
        request(app).get("/finance/other-documents"),
        request(app).post("/finance/other-documents"),
        request(app).patch("/finance/other-documents/00000000-0000-0000-0000-000000000000"),
        request(app).delete("/finance/other-documents/00000000-0000-0000-0000-000000000000"),
      ]);
      results.forEach((res) => expect(res.status).toBe(401));
    });
  });
});
