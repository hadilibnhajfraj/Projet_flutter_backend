"use strict";

// Extraction de champs structurés à partir du texte/des mots positionnés
// renvoyés par invoiceOcr.service.js. Approche regex/heuristique (pas de
// modèle ML/vision) — chaque champ renvoie systématiquement une confiance ;
// une valeur non trouvée reste `null`, jamais devinée.

const { PDFParse } = require("pdf-parse");
const { normalizeNumber, normalizeDate, normalizeMeshSize, normalizeDiameter } = require("./invoiceNormalization.service");

const GOVERNORATES = [
  "Tunis", "Ariana", "Ben Arous", "Manouba", "Nabeul", "Zaghouan", "Bizerte",
  "Béja", "Beja", "Jendouba", "Kef", "Le Kef", "Siliana", "Sousse", "Monastir",
  "Mahdia", "Sfax", "Kairouan", "Kasserine", "Sidi Bouzid", "Gabès", "Gabes",
  "Médenine", "Medenine", "Tataouine", "Gafsa", "Tozeur", "Kébili", "Kebili",
];

function field(value, confidence) {
  return { value: value === undefined ? null : value, confidence: value === null || value === undefined ? 0 : confidence };
}

// Cherche un label (ex: "Client") suivi de ":" ou d'espaces puis capture le
// reste de la ligne. `confidence` haute (label explicite trouvé).
function extractLabeled(text, labelPatterns, { maxLength = 200 } = {}) {
  for (const label of labelPatterns) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n]{1,${maxLength}})`, "i");
    const m = text.match(re);
    if (m) {
      const value = m[1].trim().replace(/\s{2,}/g, " ");
      if (value) return field(value, 0.9);
    }
  }
  return field(null, 0);
}

function extractInvoiceNumber(text) {
  return extractLabeled(text, ["FACTURE\\s*N[°ºo:]*", "N[°ºo]\\s*(?:DE\\s*)?FACTURE", "INVOICE\\s*(?:N[°ºo:]*|NUMBER)"], {
    maxLength: 30,
  });
}

function extractInvoiceDate(text) {
  const labeled = extractLabeled(text, ["DATE\\s*(?:DE\\s*FACTURATION)?"], { maxLength: 20 });
  if (labeled.value) {
    const normalized = normalizeDate(labeled.value);
    if (normalized) return field(normalized, 0.9);
  }
  // Repli : premier motif de date trouvé n'importe où dans le document
  // (confiance réduite — aucun label explicite ne le rattache à "la" date).
  const m = text.match(/\b(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/);
  if (m) {
    const normalized = normalizeDate(m[1]);
    if (normalized) return field(normalized, 0.5);
  }
  return field(null, 0);
}

function extractReference(text) {
  // Pas de repli "REF\.?" nu : ce fragment matche aussi la cellule d'en-tête
  // "Ref" de la première colonne du tableau produits (sans ":"), capturant
  // alors le reste de la ligne d'en-tête ("Designation Unite Diam...") comme
  // si c'était la référence du document — seul le mot complet
  // "Référence"/"Reference" identifie sans ambiguïté ce champ.
  return extractLabeled(text, ["R[ée]f[ée]rence(?:\\s*client)?"], { maxLength: 40 });
}

// Priorité : label explicite ("Gouvernorat") > gouvernorat trouvé DANS
// l'adresse client > balayage du texte entier en dernier recours (confiance
// dégressive) — un balayage seul est ambigu (un nom de gouvernorat peut
// apparaître dans un autre champ sans rapport, ex. le nom d'une rue).
function findGovernorateIn(text) {
  if (!text) return null;
  for (const g of GOVERNORATES) {
    if (new RegExp(`\\b${g}\\b`, "i").test(text)) return g;
  }
  return null;
}

// "C MF" — code client tel qu'imprimé sur le document (ex. "C1836134R").
function extractCustomerCode(text) {
  return extractLabeled(text, ["C\\s*MF"], { maxLength: 40 });
}

// Le code client ("C1836134R") est souvent le matricule fiscal préfixé d'un
// "C" — quand aucun libellé "Matricule Fiscal" distinct n'est présent sur le
// document, on dérive customerTaxId à partir de customerCode en retirant ce
// préfixe, plutôt que de laisser customerTaxId vide alors que la donnée est
// là (juste sous un autre libellé).
function deriveTaxIdFromCode(code) {
  if (!code) return null;
  const m = String(code).match(/^C(\d.*)$/i);
  return m ? m[1] : code;
}

function extractCustomer(text) {
  // Les libellés composés ("Nom client", "Matricule Fiscal client") sont
  // essayés AVANT le repli nu "CLIENT" : sinon, comme "CLIENT" est une
  // sous-chaîne de "Matricule Fiscal CLIENT", il matcherait cette ligne en
  // premier si elle précède "Nom client" dans le document.
  const name = extractLabeled(text, ["NOM\\s*(?:DU\\s*)?CLIENT", "RAISON\\s*SOCIALE", "CLIENT"], { maxLength: 100 });
  const phone = extractLabeled(text, ["T[ée]l[ée]?(?:phone)?\\.?", "GSM", "MOBILE"], { maxLength: 30 });
  const address = extractLabeled(text, ["ADRESSE"], { maxLength: 200 });
  const code = extractCustomerCode(text);
  let taxId = extractLabeled(text, ["MATRICULE\\s*FISCAL(?:\\s*CLIENT)?"], { maxLength: 40 });
  if (!taxId.value && code.value) {
    const derived = deriveTaxIdFromCode(code.value);
    if (derived) taxId = field(derived, code.confidence);
  }

  const labeledGovernorate = extractLabeled(text, ["GOUVERNORAT"], { maxLength: 40 });
  let governorate = field(null, 0);
  if (labeledGovernorate.value) {
    governorate = field(findGovernorateIn(labeledGovernorate.value) || labeledGovernorate.value, 0.9);
  } else {
    const inAddress = findGovernorateIn(address.value);
    if (inAddress) governorate = field(inAddress, 0.75);
    else {
      const anywhere = findGovernorateIn(text);
      if (anywhere) governorate = field(anywhere, 0.6);
    }
  }

  return { name, phone, address, governorate, taxId, code };
}

function extractTotals(text) {
  const subtotalHT = extractLabeled(text, ["SOUS-TOTAL\\s*HT", "TOTAL\\s*HT", "MONTANT\\s*HT\\s*TOTAL"], { maxLength: 30 });
  const totalTax = extractLabeled(text, ["TOTAL\\s*TAXE", "TOTAL\\s*TVA", "TVA"], { maxLength: 30 });
  const totalTTC = extractLabeled(text, ["TOTAL\\s*TTC", "NET\\s*[àa]\\s*PAYER", "MONTANT\\s*TTC"], { maxLength: 30 });
  const downPayment = extractLabeled(text, ["ACOMPTE"], { maxLength: 30 });
  const netToPay = extractLabeled(text, ["NET\\s*[àa]\\s*PAYER"], { maxLength: 30 });

  return {
    subtotalHT: field(subtotalHT.value ? normalizeNumber(subtotalHT.value) : null, subtotalHT.confidence),
    totalTax: field(totalTax.value ? normalizeNumber(totalTax.value) : null, totalTax.confidence),
    totalTTC: field(totalTTC.value ? normalizeNumber(totalTTC.value) : null, totalTTC.confidence),
    downPayment: field(downPayment.value ? normalizeNumber(downPayment.value) : null, downPayment.confidence),
    netToPay: field(netToPay.value ? normalizeNumber(netToPay.value) : null, netToPay.confidence),
  };
}

function extractAmountInWords(text) {
  return extractLabeled(text, ["ARR[ÊE]T[ÉE]E?\\s*LA\\s*PR[ÉE]SENTE\\s*FACTURE[^:]*:?"], { maxLength: 150 });
}

// Normalise n'importe quelle variante de casse/accents trouvée sur le
// document ("TRAITE", "traite", "Traite"...) vers EXACTEMENT l'une des 4
// valeurs du dropdown "Register payment" (§PAYMENT METHOD) — jamais une
// autre valeur : un mode non reconnu retourne null plutôt qu'une valeur
// inventée (préférence explicite du ticket : "Le système doit utiliser la
// valeur réellement présente dans le document").
const PAYMENT_METHOD_CANONICAL = { TRAITE: "Traite", CHEQUE: "Chèque", VIREMENT: "Virement", VERSEMENT: "Versement" };
function canonicalizePaymentMethod(raw) {
  if (!raw) return null;
  const norm = String(raw)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  return PAYMENT_METHOD_CANONICAL[norm] || null;
}

function extractPaymentLinear(text) {
  const condition = extractLabeled(text, ["CONDITIONS?\\s*DE\\s*R[ÈE]GLEMENT"], { maxLength: 60 });
  let date = field(null, 0);
  if (condition.value) {
    const m = condition.value.match(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/);
    if (m) {
      const normalized = normalizeDate(m[0]);
      if (normalized) date = field(normalized, condition.confidence);
    }
  }
  const methodMatch = text.match(/\b(TRAITE|CH[ÈE]QUE|VIREMENT|VERSEMENT)\b/i);
  const canonicalMethod = methodMatch ? canonicalizePaymentMethod(methodMatch[1]) : null;
  const method = canonicalMethod ? field(canonicalMethod, 0.6) : field(null, 0);
  return { condition, date, method };
}

// ── TABLEAU DE LIGNES ───────────────────────────────────────────────────

const COLUMN_KEYWORDS = [
  { key: "reference", patterns: ["REF", "REFERENCE"] },
  { key: "designation", patterns: ["DESIGNATION", "LIBELLE"] },
  { key: "unit", patterns: ["UNITE", "UNIT"] },
  { key: "diameter", patterns: ["DIAM"] },
  { key: "meshSize", patterns: ["MAILLE", "MESH"] },
  { key: "quantity", patterns: ["QTE", "QTY", "QUANTITE"] },
  { key: "unitPriceHT", patterns: ["PU", "P.U", "PRIXUNITAIRE"] },
  { key: "rms", patterns: ["RMS"] },
  { key: "amountHT", patterns: ["MONTANT", "AMOUNT"] },
  { key: "tax1", patterns: ["TAXE", "TVA"] }, // 1re occurrence "TAXE" → tax1, 2e → tax2 (voir matchColumnKey)
];

function normalizeHeaderCell(cell) {
  return String(cell || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // enlève les accents (marques diacritiques combinantes)
    .replace(/[^A-Z]/g, "");
}

function matchColumnKey(headerCell, taxSeenRef) {
  const norm = normalizeHeaderCell(headerCell);
  if (!norm || norm.length < 2) return null;
  for (const { key, patterns } of COLUMN_KEYWORDS) {
    // Bidirectionnel : un en-tête PDF peut être tronqué par un retour à la
    // ligne dans une colonne étroite (ex. "Montan" pour "Montant") — vérifier
    // seulement `norm.includes(p)` raterait ce cas. Mais `p.includes(norm)`
    // (norm est une ABRÉVIATION du mot-clé) est dangereux si `norm` est très
    // court : une valeur banale comme "le" (dans "le 23/07/26"), une fois
    // les caractères non-lettres retirés, se réduit à "LE" — qui se trouve
    // être une sous-chaîne de "LIBELLE" par pur hasard, la faisant passer à
    // tort pour un en-tête de colonne "désignation" (déjà rencontré : un
    // code client réduit à "CE" ⊂ "REFERENCE"). On exige donc au moins 3
    // caractères pour cette direction.
    if (patterns.some((p) => norm.includes(p) || (norm.length >= 3 && p.includes(norm)))) {
      if (key === "tax1") {
        taxSeenRef.count += 1;
        return taxSeenRef.count === 1 ? "tax1" : "tax2";
      }
      return key;
    }
  }
  return null;
}

const NUMERIC_ITEM_FIELDS = new Set(["quantity", "unitPriceHT", "rms", "amountHT", "tax1", "tax2"]);

function buildItemFromCells(columnKeys, cells) {
  const item = {};
  let filled = 0;
  columnKeys.forEach((key, i) => {
    if (!key) return;
    const raw = (cells[i] || "").trim();
    if (!raw) return;
    let value;
    if (key === "meshSize") value = normalizeMeshSize(raw) || raw;
    else if (key === "diameter") value = normalizeDiameter(raw);
    else if (NUMERIC_ITEM_FIELDS.has(key)) value = normalizeNumber(raw);
    else value = raw;
    if (value !== null && value !== undefined && value !== "") {
      item[key] = value;
      filled += 1;
    }
  });
  return { item, filled };
}

// Chemin PDF texte natif : `pdf-parse` sait déjà détecter des tableaux
// bordés (`getTable`) — bien plus fiable qu'une heuristique de position sur
// du texte OCR. `parser` est déjà chargé par invoiceOcr.service.js ; on lui
// laisse la responsabilité d'appeler destroy().
async function extractItemsFromPdfTable(filePath) {
  const fs = require("fs");
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  try {
    const result = await parser.getTable();
    const items = [];
    for (const page of result.pages || []) {
      for (const table of page.tables || []) {
        if (!table.length) continue;
        const taxSeenRef = { count: 0 };
        const columnKeys = table[0].map((h) => matchColumnKey(h, taxSeenRef));
        if (!columnKeys.some(Boolean)) continue; // pas un tableau de lignes de facture reconnaissable
        for (let r = 1; r < table.length; r++) {
          const { item, filled } = buildItemFromCells(columnKeys, table[r]);
          if (filled >= 2) items.push({ ...item, confidence: Math.min(0.9, 0.4 + filled * 0.08) });
        }
      }
    }
    return items;
  } catch (_) {
    return [];
  } finally {
    await parser.destroy();
  }
}

// Chemin OCR (image / PDF scanné) : reconstruit les lignes/colonnes à partir
// des mots positionnés (bbox) renvoyés par Tesseract — jamais une simple
// liste de mots, les relations de colonnes doivent être conservées.
function extractItemsFromWords(words) {
  if (!words || !words.length) return [];

  const sorted = [...words].sort((a, b) => a.top - b.top);
  const medianHeight = sorted.map((w) => w.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 20;
  const rowTolerance = medianHeight * 0.6;

  const rows = [];
  for (const w of sorted) {
    const centerY = w.top + w.height / 2;
    let row = rows.find((r) => Math.abs(r.centerY - centerY) <= rowTolerance);
    if (!row) {
      row = { centerY, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  rows.forEach((r) => r.words.sort((a, b) => a.left - b.left));

  // Trouve la ligne d'en-tête : celle qui matche le plus de mots-clés colonnes.
  let headerIdx = -1;
  let bestMatches = 0;
  rows.forEach((row, i) => {
    const taxSeenRef = { count: 0 };
    const matches = row.words.filter((w) => matchColumnKey(w.text, taxSeenRef)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      headerIdx = i;
    }
  });
  if (headerIdx === -1 || bestMatches < 2) return [];

  const taxSeenRef = { count: 0 };
  const columns = rows[headerIdx].words
    .map((w) => ({ key: matchColumnKey(w.text, taxSeenRef), left: w.left, right: w.left + w.width }))
    .filter((c) => c.key);
  // Étend chaque colonne jusqu'à mi-chemin de la suivante pour couvrir les
  // mots qui débordent légèrement de l'en-tête.
  columns.sort((a, b) => a.left - b.left);
  columns.forEach((c, i) => {
    c.rangeStart = i === 0 ? -Infinity : (columns[i - 1].right + c.left) / 2;
    c.rangeEnd = i === columns.length - 1 ? Infinity : (c.right + columns[i + 1].left) / 2;
  });

  const items = [];
  const stopWords = ["SOUS-TOTAL", "TOTAL", "NET A PAYER", "NETAPAYER"];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const lineText = normalizeHeaderCell(rows[i].words.map((w) => w.text).join(""));
    if (stopWords.some((s) => lineText.includes(normalizeHeaderCell(s)))) break;

    const cellsByKey = {};
    for (const w of rows[i].words) {
      const center = w.left + w.width / 2;
      const col = columns.find((c) => center >= c.rangeStart && center < c.rangeEnd);
      if (!col) continue;
      cellsByKey[col.key] = cellsByKey[col.key] ? `${cellsByKey[col.key]} ${w.text}` : w.text;
    }
    const columnKeys = Object.keys(cellsByKey);
    const cells = columnKeys.map((k) => cellsByKey[k]);
    const { item, filled } = buildItemFromCells(columnKeys, cells);
    if (filled >= 2) items.push({ ...item, confidence: Math.min(0.85, 0.3 + filled * 0.08) });
  }
  return items;
}

// Position Y de la rangée d'en-tête du tableau produits (celle qui matche
// le plus de mots-clés colonnes) — sert à borner la recherche du champ
// document-level "Référence" (voir extractInvoiceFieldsPositional) : sans
// cette borne, le mot "Référence" de l'EN-TÊTE du tableau (qui matche le
// même pattern que le libellé document) serait pris pour LE libellé, et la
// recherche "en dessous" aspirerait les références PRODUITS de chaque
// ligne — jamais un libellé de colonne ne doit devenir une valeur document.
function findItemTableHeaderRowTop(words) {
  if (!words || !words.length) return null;
  const sorted = [...words].sort((a, b) => a.top - b.top);
  const medianHeight = sorted.map((w) => w.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 20;
  const rowTolerance = medianHeight * 0.6;
  const rows = [];
  for (const w of sorted) {
    const centerY = w.top + w.height / 2;
    let row = rows.find((r) => Math.abs(r.centerY - centerY) <= rowTolerance);
    if (!row) {
      row = { centerY, top: w.top, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  let bestIdx = -1;
  let bestMatches = 0;
  rows.forEach((row, i) => {
    const taxSeenRef = { count: 0 };
    const matches = row.words.filter((w) => matchColumnKey(w.text, taxSeenRef)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      bestIdx = i;
    }
  });
  return bestIdx === -1 || bestMatches < 2 ? null : rows[bestIdx].top;
}

async function extractInvoiceItems({ filePath, engine, pages }) {
  if (engine === "pdf-text") {
    const items = await extractItemsFromPdfTable(filePath);
    if (items.length) return items;
  }
  // Repli (ou moteur OCR) : reconstruction par position des mots.
  const allWords = (pages || []).flatMap((p) => p.words || []);
  return extractItemsFromWords(allWords);
}

// ── BLOC FISCAL (Code / Base / Taux / Taxe) ─────────────────────────────
// Même algorithme de reconstruction de tableau par position que le tableau
// produits ci-dessus (en-tête détecté par le plus grand nombre de mots-clés
// colonnes reconnus, puis chaque ligne suivante affectée par position X),
// appliqué au bloc fiscal en bas de facture. Nombre de lignes dynamique —
// jamais supposé à 2 ou 3 (§STRUCTURE DES TAXES).
const TAX_COLUMN_KEYWORDS = [
  { key: "code", patterns: ["CODE"] },
  { key: "base", patterns: ["BASE"] },
  { key: "rate", patterns: ["TAUX"] },
  { key: "amount", patterns: ["TAXE"] },
];

function matchTaxColumnKey(headerCell) {
  const norm = normalizeHeaderCell(headerCell);
  if (!norm || norm.length < 2) return null;
  for (const { key, patterns } of TAX_COLUMN_KEYWORDS) {
    if (patterns.some((p) => norm.includes(p) || (norm.length >= 3 && p.includes(norm)))) return key;
  }
  return null;
}

function extractTaxesFromWords(words) {
  if (!words || !words.length) return { taxes: [], fiscalTotal: null };

  const sorted = [...words].sort((a, b) => a.top - b.top);
  const medianHeight = sorted.map((w) => w.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 20;
  const rowTolerance = medianHeight * 0.6;

  const rows = [];
  for (const w of sorted) {
    const centerY = w.top + w.height / 2;
    let row = rows.find((r) => Math.abs(r.centerY - centerY) <= rowTolerance);
    if (!row) {
      row = { centerY, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  rows.forEach((r) => r.words.sort((a, b) => a.left - b.left));

  // Au moins 3 des 4 mots-clés (Code/Base/Taux/Taxe) requis pour retenir une
  // ligne d'en-tête : le tableau PRODUITS a lui-même "Taxe1"/"Taxe2" qui, une
  // fois les chiffres retirés par normalizeHeaderCell, se réduisent tous les
  // deux à "TAXE" et ne scoreraient que 2 — jamais retenus par erreur ici.
  let headerIdx = -1;
  let bestMatches = 0;
  rows.forEach((row, i) => {
    const matches = row.words.filter((w) => matchTaxColumnKey(w.text)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      headerIdx = i;
    }
  });
  if (headerIdx === -1 || bestMatches < 3) return { taxes: [], fiscalTotal: null };

  const columns = rows[headerIdx].words
    .map((w) => ({ key: matchTaxColumnKey(w.text), left: w.left, right: w.left + w.width }))
    .filter((c) => c.key);
  columns.sort((a, b) => a.left - b.left);
  // Le bloc fiscal (Code/Base/Taux/Taxe) est visuellement ÉTROIT et partage
  // souvent sa rangée Y avec le bloc commercial voisin (Total HT/TTC/
  // Acompte, aligné sur la même ligne que la 1re ligne de taxe) — sans
  // borne à droite, la dernière colonne "Taxe" (montant) aspirerait ces
  // valeurs SANS RAPPORT. On borne donc la dernière colonne à l'écart
  // observé entre les 2 dernières colonnes d'en-tête (rythme propre à CE
  // document), jamais une largeur infinie.
  const lastColumnGap = columns.length >= 2 ? columns[columns.length - 1].left - columns[columns.length - 2].left : 100;
  columns.forEach((c, i) => {
    c.rangeStart = i === 0 ? -Infinity : (columns[i - 1].right + c.left) / 2;
    c.rangeEnd = i === columns.length - 1 ? c.right + lastColumnGap : (c.right + columns[i + 1].left) / 2;
  });

  const taxes = [];
  // Ligne "Total" du bloc fiscal (somme Base/Taxe DÉJÀ calculée et IMPRIMÉE
  // par le document) — plus fiable qu'une re-somme des lignes individuelles
  // côté serveur si l'une d'elles a une cellule Taxe manquante/tronquée
  // (jamais recalculée nous-mêmes, juste LUE).
  let fiscalTotal = null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const isTotalRow = rows[i].words.some((w) => /^TOTAL$/i.test(w.text.trim()));

    const cellsByKey = {};
    for (const w of rows[i].words) {
      const center = w.left + w.width / 2;
      const col = columns.find((c) => center >= c.rangeStart && center < c.rangeEnd);
      if (!col) continue;
      cellsByKey[col.key] = cellsByKey[col.key] ? `${cellsByKey[col.key]} ${w.text}` : w.text;
    }

    if (isTotalRow) {
      fiscalTotal = {
        base: cellsByKey.base ? normalizeNumber(cellsByKey.base) : null,
        amount: cellsByKey.amount ? normalizeNumber(cellsByKey.amount) : null,
      };
      break;
    }

    if (!cellsByKey.code) continue; // une ligne de taxe a toujours un code (F1V/C19/TFV...)

    taxes.push({
      code: cellsByKey.code,
      base: cellsByKey.base ? normalizeNumber(cellsByKey.base) : null,
      rate: cellsByKey.rate ? normalizeNumber(cellsByKey.rate) : null,
      amount: cellsByKey.amount ? normalizeNumber(cellsByKey.amount) : null,
      confidence: 0.85,
    });
  }
  return { taxes, fiscalTotal };
}

async function extractInvoiceFieldsLinear({ fullText, filePath, engine, pages }) {
  return {
    invoiceNumber: extractInvoiceNumber(fullText),
    invoiceDate: extractInvoiceDate(fullText),
    reference: extractReference(fullText),
    customer: extractCustomer(fullText),
    totals: extractTotals(fullText),
    // Le détail des taxes (nombre de lignes dynamique) exige la position
    // réelle des colonnes du bloc fiscal — non reconstructible depuis le
    // texte linéaire aplati, jamais deviné : tableau vide en repli.
    taxes: [],
    payment: extractPaymentLinear(fullText),
    amountInWords: extractAmountInWords(fullText),
    items: await extractInvoiceItems({ filePath, engine, pages }),
    format: "SAGE",
  };
}

// ══════════════════════════════════════════════════════════════════════
// EXTRACTION POSITIONNELLE (coordonnées X/Y réelles) — stratégie PRINCIPALE
// ══════════════════════════════════════════════════════════════════════
// "CORRECTION DÉFINITIVE DU PIPELINE D'EXTRACTION DES FACTURES" : la
// version ci-dessus, basée sur `pdf-parse.getText()` (texte linéaire),
// reste piégée par les factures à PLUSIEURS COLONNES (bloc Numéro/Date à
// gauche, bloc client à droite, bloc fiscal Code/Base/Taux/Taxe et bloc
// commercial Total HT/TTC côte à côte en bas) — le texte aplati entrelace
// ces colonnes hors de l'ordre de lecture visuel. Même architecture que
// deliveryNoteFieldExtraction.service.js (§CORRECTION CRITIQUE — MAPPING
// BON DE LIVRAISON), adaptée aux libellés et au bloc client SANS libellé
// (code+nom+adresse empilés, repéré par la FORME du code, pas par un mot
// voisin) propre aux factures. Repli sur extractInvoiceFieldsLinear
// uniquement si aucun mot positionné n'est disponible ou rien de fiable
// n'a été trouvé.

const POSITIONAL_LABELS = {
  invoiceNumber: /FACTURE\s*N[°ºo:]*|N[°ºo]\s*(?:DE\s*)?FACTURE|INVOICE\s*(?:N[°ºo:]*|NUMBER)|NUM[ÉE]RO(?!\s*(?:DE\s*)?T[ÉE]L|\s*FISCAL)/i,
  documentDate: /^DATE$/i,
  phone: /T[ÉE]L[ÉE]?(?:PHONE)?\.?(?:\s*CLIENT)?|^GSM$|^MOBILE$/i,
  reference: /^R[ÉE]F[ÉE]RENCE(?:\s*CLIENT)?$/i,
  // Volontairement PAS "C MF" ici : ce libellé porte le CODE client (avec
  // préfixe "C"), pas le matricule fiscal — voir extractCustomerPositional,
  // qui dérive taxId de code UNIQUEMENT si aucun "Matricule Fiscal" séparé
  // n'existe (même logique que extractCustomer côté texte linéaire).
  taxId: /MATRICULE\s*FISCAL(?:\s*CLIENT)?/i,
  customerCode: /^C\s*MF$/i,
  name: /NOM\s*(?:DU\s*)?CLIENT|RAISON\s*SOCIALE/i,
  address: /^ADRESSE$/i,
  governorate: /GOUVERNORAT|GOUVERNERATE/i,
  subtotalHT: /^(?:SOUS-)?TOTAL\s*HT$/i,
  totalTTC: /^TOTAL\s*TTC$/i,
  // Certaines factures n'ont ni bloc fiscal Code/Base/Taux/Taxe ni "Total
  // TTC" imprimés — juste "Total HT" / "TVA" / "NET À PAYER" à plat (§11).
  // Sans ce libellé dédié, le total des taxes resterait à tort null (donc
  // sauvegardé à 0) alors que la valeur est bien présente sur le document.
  totalTaxLabel: /^(?:TOTAL\s*)?TVA$|^TOTAL\s*TAXE$/i,
  downPayment: /^ACOMPTE$/i,
  netToPay: /NET\s*[ÀA]\s*PAYER/i,
  paymentCondition: /CONDITIONS?\s*DE\s*R[ÈE]GLEMENT/i,
  amountInWordsLabel: /ARR[ÊE]T[ÉE]E?\s*LA\s*PR[ÉE]SENTE\s*FACTURE/i,
  // "CLIENT" nu : seulement en tout dernier recours, jamais s'il s'agit en
  // réalité de "Matricule Fiscal CLIENT"/"téléphone CLIENT".
  bareClient: /(?<!T[ÉE]L[ÉE]?(?:PHONE)?\.?\s)(?<!FISCAL\s)^CLIENT$/i,
};

// Modes de règlement connus — recherchés comme un mot NU (jamais une
// sous-chaîne) sur la même rangée que le libellé "Conditions de
// règlement", qui n'a lui-même aucun libellé propre les rattachant
// (juxtaposés sur la même ligne, ex. "Conditions de règlement : le
// 23/07/26   Traite   20 122,345").
const PAYMENT_METHOD_WORDS = /^(TRAITE|CH[ÈE]QUE|VIREMENT|VERSEMENT)$/i;

function extractPaymentMethodNearLabel(words, labelWord) {
  if (!labelWord) return field(null, 0);
  const candidate = words.find((w) => w !== labelWord && Math.abs(w.top - labelWord.top) <= 3 && PAYMENT_METHOD_WORDS.test(w.text.trim()));
  if (!candidate) return field(null, 0);
  const canonical = canonicalizePaymentMethod(candidate.text.trim());
  return canonical ? field(canonical, 0.85) : field(null, 0);
}
const POSITIONAL_SECTION_MARKERS = [
  /^FACTURE$/i,
  /^PAGE$/i,
  /SAGE/i,
  /^CODE$/i,
  /^BASE$/i,
  /^TAUX$/i,
  /^TAXE$/i,
  // Ligne "Total" du bloc FISCAL (somme Base/Taxe) — jamais confondue avec
  // "Total HT"/"Total TTC" du bloc commercial (motifs ancrés avec suffixe).
  /^TOTAL$/i,
];

// Certaines factures impriment "Libellé:"/"Libellé =" en mot séparé de sa
// valeur, d'autres "Libellé: Valeur" comme UNE SEULE chaîne — seule la
// partie AVANT le premier séparateur doit être testée contre les patterns
// de libellé (souvent ancrés `^...$`).
function positionalLabelPrefix(text) {
  if (!text) return "";
  const trimmed = text.trim().replace(/[:=]\s*$/, "");
  const sepIdx = trimmed.search(/[:=]/);
  return sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx).trim();
}

// Le moteur positionnel (isPositionalLabel/claim.../buildPositionalExtractor)
// est PARAMÉTRÉ par un `ctx` (libellés/marqueurs de section/matcher de
// colonnes) plutôt que codé en dur sur POSITIONAL_LABELS — §MODIFICATION —
// SCAN / OCR DES FACTURES : SUPPORT DE 2 FORMATS : réutilisé tel quel pour le
// format SUPPLIER (extractSupplierInvoiceFieldsPositional plus bas) via un
// second ctx, sans dupliquer la mécanique de reconstruction par position.
// Tous les appels existants (format SAGE) omettent `ctx` → comportement
// strictement identique à avant (DEFAULT_POSITIONAL_CTX = les mêmes globals).
const DEFAULT_POSITIONAL_CTX = {
  labels: POSITIONAL_LABELS,
  sectionMarkers: POSITIONAL_SECTION_MARKERS,
  columnMatcher: (n) => matchColumnKey(n, { count: 0 }),
};

function isPositionalLabel(text, ctx = DEFAULT_POSITIONAL_CTX) {
  if (!text) return false;
  const normalized = positionalLabelPrefix(text);
  if (Object.values(ctx.labels).some((re) => re.test(normalized))) return true;
  if (ctx.sectionMarkers.some((re) => re.test(normalized))) return true;
  return Boolean(ctx.columnMatcher(normalized)); // en-têtes du tableau produits
}

function findAllPositionalLabels(words, ctx = DEFAULT_POSITIONAL_CTX) {
  return words.filter((w) => isPositionalLabel(w.text, ctx));
}

// PASSE 1 — paires "libellé : valeur" sur la MÊME rangée (tolérance Y
// serrée ~2.5pt). Réclamées AVANT la passe 2 pour qu'une valeur ainsi
// identifiée ne puisse plus être aspirée par un autre libellé plus bas.
function claimPositionalSameRowValues(words, labels, claimed, ctx = DEFAULT_POSITIONAL_CTX) {
  const result = new Map();
  for (const label of labels) {
    const hasRowSiblings = labels.some((o) => o !== label && Math.abs(o.top - label.top) < 20);
    const maxGap = hasRowSiblings ? 70 : Infinity;

    const sameRow = words
      .filter((w) => !claimed.has(w) && w !== label && !isPositionalLabel(w.text, ctx))
      .filter((w) => Math.abs(w.top - label.top) <= 2.5 && w.left > label.left + label.width - 5)
      .filter((w) => w.left - (label.left + label.width) <= maxGap)
      .sort((a, b) => a.left - b.left);
    if (!sameRow.length) continue;

    const group = [sameRow[0]];
    for (let i = 1; i < sameRow.length; i++) {
      const prevEnd = group[group.length - 1].left + group[group.length - 1].width;
      if (sameRow[i].left - prevEnd > 20) break;
      group.push(sameRow[i]);
    }
    result.set(label, group.map((w) => w.text).join(" "));
    group.forEach((w) => claimed.add(w));
  }
  return result;
}

// PASSE 2 — pour les libellés sans valeur "même rangée" : cherche EN
// DESSOUS dans la même colonne (X proche), bornée par le PROCHAIN libellé
// de cette colonne et par la compétition avec les libellés "voisins".
function findPositionalValueLines(
  words,
  labelWord,
  allLabels,
  claimed,
  { xTolerance = 150, maxGapY = 40, maxLines = 6 } = {},
  ctx = DEFAULT_POSITIONAL_CTX
) {
  if (!labelWord) return [];

  const nextLabelBelow = allLabels
    .filter((o) => o !== labelWord && o.top > labelWord.top + 5 && Math.abs(o.left - labelWord.left) <= 35)
    .sort((a, b) => a.top - b.top)[0];
  const yCeiling = nextLabelBelow ? nextLabelBelow.top - 2 : Infinity;

  const siblingLabels = allLabels.filter((o) => o !== labelWord && Math.abs(o.top - labelWord.top) < 20);

  const candidates = words
    .filter((w) => !claimed.has(w) && w !== labelWord)
    .filter((w) => w.top > labelWord.top + labelWord.height * 0.3)
    .filter((w) => w.top < yCeiling)
    .filter((w) => Math.abs(w.left - labelWord.left) <= xTolerance)
    .filter((w) => {
      const myDist = Math.abs(w.left - labelWord.left);
      return siblingLabels.every((other) => Math.abs(w.left - other.left) >= myDist);
    })
    .sort((a, b) => a.top - b.top);

  const rows = [];
  for (const w of candidates) {
    let row = rows.find((r) => Math.abs(r.top - w.top) <= 4);
    if (!row) {
      row = { top: w.top, items: [] };
      rows.push(row);
    }
    row.items.push(w);
  }
  rows.forEach((r) => r.items.sort((a, b) => a.left - b.left));
  rows.sort((a, b) => a.top - b.top);

  const lines = [];
  let lastY = labelWord.top;
  for (const row of rows) {
    if (row.top - lastY > maxGapY) break;
    if (row.items.some((it) => isPositionalLabel(it.text, ctx))) break;
    const text = row.items.map((it) => it.text).join(" ");
    if (!/^VIDE$/i.test(text)) lines.push(text);
    row.items.forEach((it) => claimed.add(it));
    lastY = row.top;
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function buildPositionalExtractor(words, claimed, ctx = DEFAULT_POSITIONAL_CTX) {
  const allLabels = findAllPositionalLabels(words, ctx);
  const sameRowValues = claimPositionalSameRowValues(words, allLabels, claimed, ctx);

  const extractPositionalField = function (pattern, opts) {
    opts = opts || {};
    const candidateLabels = opts.beforeY != null ? allLabels.filter((w) => w.top < opts.beforeY) : allLabels;
    const label = candidateLabels.find((w) => pattern.test(positionalLabelPrefix(w.text)));
    if (!label) return field(null, 0);

    const embeddedMatch = label.text.match(/[:=]\s*(\S.*)$/);
    if (embeddedMatch) {
      const embedded = embeddedMatch[1].trim();
      return /^VIDE$/i.test(embedded) ? field(null, 0) : field(embedded, 0.9);
    }

    if (sameRowValues.has(label)) {
      const v = sameRowValues.get(label);
      return /^VIDE$/i.test(v) ? field(null, 0) : field(v, 0.9);
    }
    const lines = findPositionalValueLines(words, label, allLabels, claimed, opts, ctx);
    return lines.length ? field(lines.join("\n"), 0.85) : field(null, 0);
  };
  return { extractPositionalField, allLabels };
}

// Bloc client SANS libellé adjacent (ex. "C1219489FP\nLES ASTRES
// PROMOTION\nIMM BADR 7EME ETAGE A72 KHEZEMA\nOUEST 4071 SOUSSE" positionné
// en haut à droite, sans "Client"/"Nom client" au-dessus) — repéré par la
// FORME du code client lui-même (préfixe "C" + ≥5 chiffres), pas par un
// libellé voisin. Dernier recours, seulement si aucun nom/code labellisé
// n'a été trouvé ailleurs (autre style de facture réel déjà vu ce projet :
// "C MF: C1836134R" + "Nom client: ...", labellisé celui-là).
function extractCustomerBlockPositional(words, claimed) {
  const empty = { code: field(null, 0), name: field(null, 0), address: field(null, 0) };
  const codeWord = words.find((w) => !claimed.has(w) && /^C\d{5,}[A-Z]{0,3}$/i.test(w.text.trim()));
  if (!codeWord) return empty;

  const sameColumn = words
    .filter((w) => !claimed.has(w) && w !== codeWord)
    .filter((w) => w.top > codeWord.top)
    .filter((w) => Math.abs(w.left - codeWord.left) <= 40)
    .sort((a, b) => a.top - b.top);

  const rows = [];
  for (const w of sameColumn) {
    let row = rows.find((r) => Math.abs(r.top - w.top) <= 4);
    if (!row) {
      row = { top: w.top, items: [] };
      rows.push(row);
    }
    row.items.push(w);
  }
  rows.forEach((r) => r.items.sort((a, b) => a.left - b.left));
  rows.sort((a, b) => a.top - b.top);

  const lines = [];
  const claimedHere = [codeWord];
  let lastY = codeWord.top;
  for (const row of rows) {
    if (row.top - lastY > 25) break;
    if (row.items.some((it) => isPositionalLabel(it.text))) break;
    lines.push(row.items.map((it) => it.text).join(" "));
    claimedHere.push(...row.items);
    lastY = row.top;
    if (lines.length >= 4) break;
  }
  if (!lines.length) return empty;

  claimedHere.forEach((w) => claimed.add(w));
  const name = field(lines[0], 0.85);
  const address = lines.length > 1 ? field(lines.slice(1).join(" "), 0.8) : field(null, 0);
  return { code: field(codeWord.text.trim(), 0.85), name, address };
}

function extractCustomerPositional(words, extractPositionalField, claimed) {
  let taxId = extractPositionalField(POSITIONAL_LABELS.taxId, {});
  const address = extractPositionalField(POSITIONAL_LABELS.address, {});
  const labeledName = extractPositionalField(POSITIONAL_LABELS.name, {});
  const bareClientName = labeledName.value ? field(null, 0) : extractPositionalField(POSITIONAL_LABELS.bareClient, {});
  const labeledCode = extractPositionalField(POSITIONAL_LABELS.customerCode, {});

  // Le bloc SANS libellé n'est cherché que si rien n'a déjà été trouvé par
  // libellé — sinon il risquerait de re-capturer un code/nom déjà rattaché
  // à son propre libellé ailleurs sur le document.
  const needsBlock = !labeledName.value && !bareClientName.value && !labeledCode.value;
  const block = needsBlock ? extractCustomerBlockPositional(words, claimed) : { code: field(null, 0), name: field(null, 0), address: field(null, 0) };

  const name = labeledName.value ? labeledName : bareClientName.value ? bareClientName : block.name;
  const code = labeledCode.value ? labeledCode : block.code;
  const finalAddress = address.value ? address : block.address;

  if (!taxId.value && code.value) {
    const derived = deriveTaxIdFromCode(code.value);
    if (derived) taxId = field(derived, code.confidence);
  }

  const labeledGovernorate = extractPositionalField(POSITIONAL_LABELS.governorate, {});
  let governorate = field(null, 0);
  if (labeledGovernorate.value) {
    governorate = field(findGovernorateIn(labeledGovernorate.value) || labeledGovernorate.value, 0.9);
  } else {
    const inAddress = findGovernorateIn(finalAddress.value);
    if (inAddress) governorate = field(inAddress, 0.75);
    else {
      const wholeText = words.map((w) => w.text).join(" ");
      const anywhere = findGovernorateIn(wholeText);
      if (anywhere) governorate = field(anywhere, 0.6);
    }
  }

  const phone = extractPositionalField(POSITIONAL_LABELS.phone, {});
  return { name, phone, address: finalAddress, governorate, taxId, code };
}

async function extractInvoiceFieldsPositional(page1Words, { fullText, filePath, engine, pages }) {
  const claimed = new Set();
  const { extractPositionalField, allLabels } = buildPositionalExtractor(page1Words, claimed);

  const invoiceNumber = extractPositionalField(POSITIONAL_LABELS.invoiceNumber, {});
  const rawDate = extractPositionalField(POSITIONAL_LABELS.documentDate, {});
  const invoiceDate = rawDate.value ? field(normalizeDate(rawDate.value), rawDate.confidence) : field(null, 0);

  // Le "Référence" DOCUMENT (au-dessus du tableau) partage son libellé avec
  // l'en-tête "Référence" du tableau PRODUITS — sans borne, un document SANS
  // référence propre capterait par erreur les références produits de chaque
  // ligne. On ne cherche donc ce champ que parmi les mots situés AU-DESSUS
  // de la rangée d'en-tête du tableau (repli sur toute la page si le
  // tableau n'a pas pu être localisé).
  const itemHeaderY = findItemTableHeaderRowTop(page1Words);
  const reference = extractPositionalField(POSITIONAL_LABELS.reference, itemHeaderY != null ? { beforeY: itemHeaderY } : {});
  const customer = extractCustomerPositional(page1Words, extractPositionalField, claimed);

  const subtotalHTRaw = extractPositionalField(POSITIONAL_LABELS.subtotalHT, {});
  const totalTTCRaw = extractPositionalField(POSITIONAL_LABELS.totalTTC, {});
  const subtotalHT = subtotalHTRaw.value != null ? normalizeNumber(subtotalHTRaw.value) : null;
  const totalTTC = totalTTCRaw.value != null ? normalizeNumber(totalTTCRaw.value) : null;

  const downPaymentRaw = extractPositionalField(POSITIONAL_LABELS.downPayment, {});
  const netToPayRaw = extractPositionalField(POSITIONAL_LABELS.netToPay, {});
  const downPayment = field(downPaymentRaw.value != null ? normalizeNumber(downPaymentRaw.value) : null, downPaymentRaw.confidence);
  const netToPay = field(netToPayRaw.value != null ? normalizeNumber(netToPayRaw.value) : null, netToPayRaw.confidence);

  // Détail des taxes lu depuis le bloc fiscal (Code/Base/Taux/Taxe, nombre
  // de lignes dynamique). Le total des taxes affiché doit correspondre à ce
  // qui est RÉELLEMENT extrait du document — priorité à la somme des lignes
  // du bloc fiscal (lu directement, priorité à la ligne "Total" du bloc
  // fiscal — déjà calculée et IMPRIMÉE par le document, donc fiable même si
  // une ligne individuelle a une cellule Taxe manquante), repli sur la somme
  // des lignes, puis sur le libellé "TVA"/"Total Taxe" imprimé À PLAT quand
  // le document n'a AUCUN bloc fiscal détaillé (§11 : "Total HT / TVA / NET
  // À PAYER" sans Code/Base/Taux), et seulement en dernier recours sur
  // Total TTC − Total HT si rien n'a pu être lu directement.
  const { taxes, fiscalTotal } = extractTaxesFromWords(page1Words);
  const totalTaxLabelRaw = extractPositionalField(POSITIONAL_LABELS.totalTaxLabel, {});
  const totalTax =
    fiscalTotal && fiscalTotal.amount != null
      ? field(fiscalTotal.amount, 0.9)
      : taxes.length && taxes.some((t) => t.amount != null)
        ? field(taxes.reduce((sum, t) => sum + (t.amount || 0), 0), 0.85)
        : totalTaxLabelRaw.value != null
          ? field(normalizeNumber(totalTaxLabelRaw.value), totalTaxLabelRaw.confidence)
          : subtotalHT != null && totalTTC != null
            ? field(totalTTC - subtotalHT, Math.min(subtotalHTRaw.confidence, totalTTCRaw.confidence))
            : field(null, 0);

  const totals = {
    subtotalHT: field(subtotalHT, subtotalHTRaw.confidence),
    totalTax,
    totalTTC: field(totalTTC, totalTTCRaw.confidence),
    downPayment,
    netToPay,
  };

  // "Conditions de règlement" : le mode de règlement (Traite/Chèque/...) est
  // juxtaposé sur la MÊME rangée que le libellé, sans libellé propre — voir
  // extractPaymentMethodNearLabel. La date est extraite du texte de la
  // condition elle-même (ex. "le 23/07/26"), jamais une autre date du
  // document (facture/livraison).
  const paymentConditionRaw = extractPositionalField(POSITIONAL_LABELS.paymentCondition, {});
  let paymentDate = field(null, 0);
  if (paymentConditionRaw.value) {
    const dateMatch = paymentConditionRaw.value.match(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/);
    if (dateMatch) {
      const normalized = normalizeDate(dateMatch[0]);
      if (normalized) paymentDate = field(normalized, paymentConditionRaw.confidence);
    }
  }
  const paymentConditionLabelWord = allLabels.find((w) => POSITIONAL_LABELS.paymentCondition.test(positionalLabelPrefix(w.text)));
  const paymentMethod = extractPaymentMethodNearLabel(page1Words, paymentConditionLabelWord);

  const amountInWords = extractPositionalField(POSITIONAL_LABELS.amountInWordsLabel, { maxLines: 3 });

  const items = await extractInvoiceItems({ filePath, engine, pages });

  return {
    invoiceNumber,
    invoiceDate,
    reference,
    customer,
    supplier: { name: field(null, 0), address: field(null, 0), phone: field(null, 0), taxId: field(null, 0) },
    references: { blNumber: field(null, 0), bcNumber: field(null, 0) },
    totals,
    taxes,
    payment: { condition: paymentConditionRaw, date: paymentDate, method: paymentMethod },
    amountInWords,
    items,
    format: "SAGE",
  };
}

// ══════════════════════════════════════════════════════════════════════
// FORMAT 2 — FACTURE FOURNISSEUR NADEC (extractNADECInvoice)
// ══════════════════════════════════════════════════════════════════════
// §CORRECTION PRIORITAIRE — EXTRACTION OCR FACTURE NADEC. Structure
// totalement différente du format SAGE : bloc fournisseur émetteur (nom +
// sigle sur 2 lignes), bloc "Client" (nom + sigle fusionnés) avec un code
// client ET un "Code TVA" DISTINCTS, références BL N°/BC N°, bloc Opérateur/
// Vendeur/Page, tableau produits SANS Diamètre/Maille (une seule colonne
// "Taxe" en taux, en-tête parfois abrégé "MT Net"), zone Taxes séparée
// (Taux TVA/Assiette/Montant taxe) ET zone Totaux séparée (Total HT/Montant
// Net/Montant Taxe(s)/Timbre Fiscal/Total TTC) — même valeur de taxe
// imprimée aux DEUX endroits sur ce document, jamais confondue avec les
// libellés voisins (§4 "ne pas confondre Assiette/Montant taxe/Total HT/
// Total TTC/Timbre fiscal"). Réutilise le MÊME moteur positionnel
// (buildPositionalExtractor/findPositionalValueLines) via un ctx dédié —
// jamais les libellés/marqueurs SAGE, pour qu'aucune valeur ne puisse migrer
// d'un format vers l'autre.

const NADEC_COLUMN_KEYWORDS = [
  { key: "reference", patterns: ["REFERENCE", "ARTICLE"] },
  { key: "designation", patterns: ["DESIGNATION"] },
  { key: "unit", patterns: ["UNITE", "UNIT"] },
  { key: "quantity", patterns: ["QUANTITE", "QTE", "QTY"] },
  { key: "unitPriceHT", patterns: ["PU"] },
  { key: "taxRate", patterns: ["TAXE", "TVA"] },
  // "MT Net" (en-tête abrégé réellement utilisé sur cette facture, §7) —
  // "MONTANT" seul couvre déjà "Montant Net"/"Montant HT" en toutes lettres
  // (chaque en-tête de colonne est UNE seule "word" — un seul appel
  // `doc.text()` par cellule, voir invoiceOcr.service.js#extractWordsFrom
  // NativePdf qui expose un item pdf.js par run de texte, jamais découpé par
  // espace interne — donc "Montant Net"/"MT Net" arrivent chacun comme UNE
  // chaîne complète, jamais scindés en mots séparés).
  { key: "amountHT", patterns: ["MONTANT", "MTNET", "MT"] },
];

function matchNADECColumnKey(headerCell) {
  const norm = normalizeHeaderCell(headerCell);
  if (!norm || norm.length < 2) return null;
  for (const { key, patterns } of NADEC_COLUMN_KEYWORDS) {
    if (patterns.some((p) => norm.includes(p) || (norm.length >= 3 && p.includes(norm)))) return key;
  }
  return null;
}

const NADEC_POSITIONAL_LABELS = {
  invoiceNumber: /N[°ºo]\s*(?:DE\s*)?FACTURE|FACTURE\s*N[°ºo:]*/i,
  documentDate: /^DATE\s*(?:FACTURE)?$/i,
  client: /^CLIENT$/i,
  // "Code / identifiant client" (41112686) est un champ DISTINCT de "Code
  // TVA" (1567517E/A/M/000) — deux libellés, deux valeurs, jamais fusionnés
  // ni l'un dérivé de l'autre (contrairement au format SAGE où "C MF" sert
  // aussi de repli pour le matricule fiscal).
  clientCode: /CODE\s*\/?\s*IDENTIFIANT\s*CLIENT|IDENTIFIANT\s*CLIENT/i,
  clientAddress: /^ADRESSE\s*CLIENT$/i,
  codeTva: /^CODE\s*TVA$/i,
  blNumber: /^BL\s*N[°ºo]?$/i,
  bcNumber: /^BC\s*N[°ºo]?$/i,
  operator: /^OP[ÉE]RATEUR$/i,
  seller: /^VENDEUR$/i,
  page: /^PAGE$/i,
  supplierName: /^FOURNISSEUR$/i,
  supplierAddress: /^ADRESSE(?:\s*FOURNISSEUR)?$/i,
  supplierPhone: /T[ÉE]L[ÉE]?(?:PHONE)?\.?|^GSM$/i,
  supplierTaxId: /TVA\s*FOURNISSEUR|MATRICULE\s*FISCAL/i,
  totalHT: /^TOTAL\s*HT$|^MONTANT\s*HT$/i,
  totalNet: /^MONTANT\s*NET$/i,
  // Ancré des DEUX côtés avec le suffixe "(S)" pour ne jamais capturer la
  // zone Taxes voisine ("Montant taxe", sans le "(s)", voir taxAmountZone
  // plus bas) — deux libellés voisins mais textuellement distincts.
  totalTax: /^MONTANT\s*TAXE\(S\)$/i,
  fiscalStamp: /^TIMBRE\s*FISCAL$/i,
  totalTTC: /^TOTAL\s*TTC$|^MONTANT\s*TTC$/i,
  // Zone Taxes (§4) — jamais le libellé nu "Taxe" (déjà utilisé comme
  // en-tête de colonne du tableau produits, §7 : un libellé nu créerait une
  // ambiguïté entre les deux occurrences sur la page).
  taxRateZone: /^TAUX\s*TVA$/i,
  taxableBase: /^ASSIETTE$/i,
  taxAmountZone: /^MONTANT\s*TAXE$/i,
  // Zone Règlement (§5) — détectée séparément, jamais déduite d'une
  // signature/tampon manuscrit(e). Reste `null` si aucune valeur imprimée
  // (voir extractPaymentMethodNearLabel, même canonicalisation que SAGE).
  paymentLabel: /^R[ÈE]GLEMENT$|MODE\s*DE\s*PAIEMENT/i,
};

const NADEC_SECTION_MARKERS = [/^FACTURE$/i, /NADEC/i, /NORD\s*AFRICAINE/i];

const NADEC_POSITIONAL_CTX = {
  labels: NADEC_POSITIONAL_LABELS,
  sectionMarkers: NADEC_SECTION_MARKERS,
  columnMatcher: (n) => matchNADECColumnKey(n),
};

// Détection du format — plusieurs indices (§6 : jamais un seul mot isolé).
// Retourne "UNKNOWN" (jamais "SAGE" par défaut) quand AUCUN indice des deux
// formats n'est présent — le dispatcher applique alors le moteur
// positionnel générique en repli (§14 "fallback / review"), sans prétendre
// à tort qu'il s'agit d'une facture SAGE identifiée.
const NADEC_FORMAT_SIGNALS = [
  /NORD\s*AFRICAINE\s*DES\s*ECHANGES\s*COMMERCIAUX/i,
  /\bNADEC\b/i,
  /N[°ºo]\s*FACTURE/i,
  /BL\s*N[°ºo]/i,
  /BC\s*N[°ºo]/i,
  /MT\s*NET/i,
  /\bASSIETTE\b/i,
  /MONTANT\s*TAXE/i,
  /TIMBRE\s*FISCAL/i,
];
const SAGE_FORMAT_SIGNALS = [
  /CONDITIONS?\s*DE\s*R[ÈE]GLEMENT/i,
  /NET\s*[ÀA]\s*PAYER/i,
  /\bACOMPTE\b/i,
  /\bC\s*MF\b/i,
  /TAXE\s*1/i,
  /TAXE\s*2/i,
  /\bSAGE\b/i,
];

function detectInvoiceFormat(fullText) {
  const text = fullText || "";
  const nadecScore = NADEC_FORMAT_SIGNALS.filter((re) => re.test(text)).length;
  const sageScore = SAGE_FORMAT_SIGNALS.filter((re) => re.test(text)).length;
  if (nadecScore === 0 && sageScore === 0) return "UNKNOWN";
  return nadecScore > sageScore ? "NADEC" : "SAGE";
}

const NADEC_NUMERIC_ITEM_FIELDS = new Set(["quantity", "unitPriceHT", "taxRate", "amountHT"]);

function buildNADECItemFromCells(columnKeys, cells) {
  const item = {};
  let filled = 0;
  columnKeys.forEach((key, i) => {
    if (!key) return;
    const raw = (cells[i] || "").trim();
    if (!raw) return;
    // §8 : les références ("PEINTU.PE-ALK/0149") ne passent JAMAIS par
    // normalizeNumber — conservées EXACTEMENT comme imprimées (points,
    // tirets, "/", zéros).
    const value = NADEC_NUMERIC_ITEM_FIELDS.has(key) ? normalizeNumber(raw) : raw;
    if (value !== null && value !== undefined && value !== "") {
      item[key] = value;
      filled += 1;
    }
  });
  return { item, filled };
}

// Même algorithme de reconstruction par position que extractItemsFromWords
// (en-tête détecté par le plus de mots-clés colonnes reconnus, puis chaque
// ligne suivante affectée par position X) — dupliqué plutôt que généralisé
// pour ne jamais risquer de régresser le tableau SAGE existant. Toujours
// piloté par position (§6) — jamais par la voie `pdf-parse.getTable()`
// (heuristique de tableau bordé du format SAGE, non réutilisée ici pour
// rester strictement position-driven comme demandé).
function extractNADECItemsFromWords(words) {
  if (!words || !words.length) return [];

  const sorted = [...words].sort((a, b) => a.top - b.top);
  const medianHeight = sorted.map((w) => w.height).sort((a, b) => a - b)[Math.floor(sorted.length / 2)] || 20;
  const rowTolerance = medianHeight * 0.6;

  const rows = [];
  for (const w of sorted) {
    const centerY = w.top + w.height / 2;
    let row = rows.find((r) => Math.abs(r.centerY - centerY) <= rowTolerance);
    if (!row) {
      row = { centerY, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  rows.forEach((r) => r.words.sort((a, b) => a.left - b.left));

  // §9-10 : les annotations manuscrites ("Resine", "ISO", signatures/
  // tampons) n'ont ni bbox de mot-clé colonne ni position dans la grille de
  // colonnes du tableau réel — elles ne peuvent matcher AUCUN `key` via
  // matchNADECColumnKey et sont donc mécaniquement exclues de la détection
  // d'en-tête ET de l'assignation aux colonnes ci-dessous (ignorées plutôt
  // qu'injectées, sans liste noire de mots à maintenir).
  let headerIdx = -1;
  let bestMatches = 0;
  rows.forEach((row, i) => {
    const matches = row.words.filter((w) => matchNADECColumnKey(w.text)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      headerIdx = i;
    }
  });
  if (headerIdx === -1 || bestMatches < 2) return [];

  const columns = rows[headerIdx].words
    .map((w) => ({ key: matchNADECColumnKey(w.text), left: w.left, right: w.left + w.width }))
    .filter((c) => c.key);
  columns.sort((a, b) => a.left - b.left);
  // §9-10 : la dernière colonne ("MT Net") est bornée à l'écart observé
  // entre les 2 dernières colonnes d'en-tête plutôt qu'étendue à l'infini —
  // sans cette borne, une annotation manuscrite écrite loin à droite du
  // tableau serait aspirée dans la dernière cellule au lieu d'être ignorée
  // (même garde que extractTaxesFromWords pour le bloc fiscal SAGE).
  const lastColumnGap = columns.length >= 2 ? columns[columns.length - 1].left - columns[columns.length - 2].left : 100;
  columns.forEach((c, i) => {
    c.rangeStart = i === 0 ? -Infinity : (columns[i - 1].right + c.left) / 2;
    c.rangeEnd = i === columns.length - 1 ? c.right + lastColumnGap : (c.right + columns[i + 1].left) / 2;
  });

  const items = [];
  const stopWords = ["TOTAL", "MONTANT TAXE", "MONTANT NET", "MONTANT HT", "MONTANT TTC", "ASSIETTE", "TIMBRE FISCAL"];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const lineText = normalizeHeaderCell(rows[i].words.map((w) => w.text).join(""));
    if (stopWords.some((s) => lineText.includes(normalizeHeaderCell(s)))) break;

    const cellsByKey = {};
    for (const w of rows[i].words) {
      const center = w.left + w.width / 2;
      const col = columns.find((c) => center >= c.rangeStart && center < c.rangeEnd);
      if (!col) continue; // hors grille de colonnes → jamais injecté (§9)
      cellsByKey[col.key] = cellsByKey[col.key] ? `${cellsByKey[col.key]} ${w.text}` : w.text;
    }
    const columnKeys = Object.keys(cellsByKey);
    const cells = columnKeys.map((k) => cellsByKey[k]);
    const { item, filled } = buildNADECItemFromCells(columnKeys, cells);
    // ≥3 champs (au lieu de 2 pour SAGE) : ce tableau n'a pas de colonnes
    // Diamètre/Maille pouvant être vides, donc une vraie ligne produit en
    // remplit toujours au moins 3 (référence+désignation+un montant) — un
    // seuil bas laisserait passer une ligne d'annotation manuscrite qui
    // n'aurait par chance rempli que 2 colonnes.
    if (filled >= 3) items.push({ ...item, confidence: Math.min(0.85, 0.3 + filled * 0.08) });
  }
  return items;
}

// Fusionne les lignes multiples capturées sous UN même libellé (ex. bloc
// adresse sur 2 lignes) avec le séparateur voulu par le modèle normalisé —
// `findPositionalValueLines` les joint par défaut avec "\n", mais le modèle
// attendu utilise ", " pour une adresse et " " pour un nom+sigle (§11).
function joinLines(f, separator) {
  if (!f.value) return f;
  return field(String(f.value).split("\n").join(separator), f.confidence);
}

async function extractNADECInvoiceFieldsPositional(words) {
  const claimed = new Set();
  const { extractPositionalField, allLabels } = buildPositionalExtractor(words, claimed, NADEC_POSITIONAL_CTX);

  const invoiceNumber = extractPositionalField(NADEC_POSITIONAL_LABELS.invoiceNumber, {});
  const rawDate = extractPositionalField(NADEC_POSITIONAL_LABELS.documentDate, {});
  const invoiceDate = rawDate.value ? field(normalizeDate(rawDate.value), rawDate.confidence) : field(null, 0);

  // Client : nom complet + sigle sur 2 lignes, fusionnés par un ESPACE —
  // "COMPOSITE BUILDING INNOVATION FIRST CBIF" (§11), contrairement au
  // fournisseur dont name/shortName restent deux champs séparés.
  const clientNameRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.client, { maxLines: 2 });
  const clientName = joinLines(clientNameRaw, " ");
  const clientCode = extractPositionalField(NADEC_POSITIONAL_LABELS.clientCode, {});
  const clientAddress = joinLines(extractPositionalField(NADEC_POSITIONAL_LABELS.clientAddress, { maxLines: 2 }), ", ");
  const codeTva = extractPositionalField(NADEC_POSITIONAL_LABELS.codeTva, {});
  const blNumber = extractPositionalField(NADEC_POSITIONAL_LABELS.blNumber, {});
  const bcNumber = extractPositionalField(NADEC_POSITIONAL_LABELS.bcNumber, {});

  const operator = extractPositionalField(NADEC_POSITIONAL_LABELS.operator, {});
  const seller = extractPositionalField(NADEC_POSITIONAL_LABELS.seller, {});
  const page = extractPositionalField(NADEC_POSITIONAL_LABELS.page, {});

  // Fournisseur : ligne 1 = raison sociale complète, ligne 2 = sigle — DEUX
  // champs distincts (name/shortName), voir §11.
  const supplierNameRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.supplierName, { maxLines: 2 });
  const supplierLines = supplierNameRaw.value ? supplierNameRaw.value.split("\n") : [];
  const supplierName = supplierLines.length ? field(supplierLines[0], supplierNameRaw.confidence) : field(null, 0);
  const supplierShortName = supplierLines.length > 1 ? field(supplierLines[1], supplierNameRaw.confidence) : field(null, 0);
  const supplierAddress = joinLines(extractPositionalField(NADEC_POSITIONAL_LABELS.supplierAddress, { maxLines: 2 }), ", ");
  const supplierPhone = extractPositionalField(NADEC_POSITIONAL_LABELS.supplierPhone, {});
  const supplierTaxId = extractPositionalField(NADEC_POSITIONAL_LABELS.supplierTaxId, {});

  const totalHTRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.totalHT, {});
  const totalNetRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.totalNet, {});
  const totalTaxRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.totalTax, {});
  const fiscalStampRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.fiscalStamp, {});
  const totalTTCRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.totalTTC, {});
  const subtotalHT = totalHTRaw.value != null ? normalizeNumber(totalHTRaw.value) : null;
  const totalNet = totalNetRaw.value != null ? normalizeNumber(totalNetRaw.value) : null;
  const totalTax = totalTaxRaw.value != null ? normalizeNumber(totalTaxRaw.value) : null;
  const fiscalStamp = fiscalStampRaw.value != null ? normalizeNumber(fiscalStampRaw.value) : null;
  const totalTTC = totalTTCRaw.value != null ? normalizeNumber(totalTTCRaw.value) : null;

  // Zone Taxes (§4) — Taux/Assiette/Montant taxe, jamais confondue avec la
  // zone Totaux voisine (labels ancrés distincts, voir NADEC_POSITIONAL_LABELS).
  const taxRateZoneRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.taxRateZone, {});
  const taxableBaseRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.taxableBase, {});
  const taxAmountZoneRaw = extractPositionalField(NADEC_POSITIONAL_LABELS.taxAmountZone, {});
  const taxesZone = {
    taxRate: field(taxRateZoneRaw.value != null ? normalizeNumber(taxRateZoneRaw.value) : null, taxRateZoneRaw.confidence),
    taxableBase: field(taxableBaseRaw.value != null ? normalizeNumber(taxableBaseRaw.value) : null, taxableBaseRaw.confidence),
    taxAmount: field(taxAmountZoneRaw.value != null ? normalizeNumber(taxAmountZoneRaw.value) : null, taxAmountZoneRaw.confidence),
  };

  // Zone Règlement (§5) — jamais une signature/tampon manuscrit(e) : réutilise
  // la MÊME canonicalisation stricte que SAGE (extractPaymentMethodNearLabel),
  // qui ne reconnaît QUE les 4 mots imprimés exacts du dropdown — n'importe
  // quel autre texte (paraphe, nom propre...) reste `null`, jamais deviné.
  const paymentLabelWord = allLabels.find((w) => NADEC_POSITIONAL_LABELS.paymentLabel.test(positionalLabelPrefix(w.text)));
  const paymentMethod = extractPaymentMethodNearLabel(words, paymentLabelWord);

  const rawItems = extractNADECItemsFromWords(words);
  const items = rawItems.map((it) => ({
    reference: it.reference ?? null,
    designation: it.designation ?? null,
    unit: it.unit ?? null,
    diameter: null,
    meshSize: null,
    quantity: it.quantity ?? null,
    unitPriceHT: it.unitPriceHT ?? null,
    rms: null,
    amountHT: it.amountHT ?? null,
    // `taxRate` (taux, ex. 19,00) réutilisé tel quel dans la colonne DB
    // existante `tax1` — aucune migration nécessaire, `tax2` reste null (ce
    // format n'a qu'un seul taux par ligne, jamais deux).
    tax1: it.taxRate ?? null,
    tax2: null,
    confidence: it.confidence,
  }));

  return {
    invoiceNumber,
    invoiceDate,
    // Pas de "Référence document" distincte dans ce format — BL N°/BC N°
    // jouent ce rôle (voir `references`, jamais fusionnés dans ce champ).
    reference: field(null, 0),
    customer: {
      name: clientName,
      phone: field(null, 0),
      address: clientAddress,
      governorate: field(null, 0),
      taxId: codeTva,
      code: clientCode,
    },
    supplier: { name: supplierName, shortName: supplierShortName, address: supplierAddress, phone: supplierPhone, taxId: supplierTaxId },
    references: { blNumber, bcNumber },
    operator,
    seller,
    page,
    totals: {
      subtotalHT: field(subtotalHT, totalHTRaw.confidence),
      totalNet: field(totalNet, totalNetRaw.confidence),
      totalTax: field(totalTax, totalTaxRaw.confidence),
      fiscalStamp: field(fiscalStamp, fiscalStampRaw.confidence),
      totalTTC: field(totalTTC, totalTTCRaw.confidence),
      downPayment: field(null, 0),
      netToPay: field(null, 0),
    },
    // Pas de tableau fiscal Code/Base/Taux/Taxe multi-lignes dans ce format
    // (contrairement à SAGE) — la zone Taxes (Taux/Assiette/Montant taxe)
    // est exposée séparément via `taxesZone`, jamais sous forme de tableau
    // inventé.
    taxes: [],
    taxesZone,
    payment: { condition: field(null, 0), date: field(null, 0), method: paymentMethod },
    amountInWords: field(null, 0),
    items,
    format: "NADEC",
  };
}

// ══════════════════════════════════════════════════════════════════════
// DISPATCHER — extractInvoice() → detectInvoiceFormat() → switch(format)
// ══════════════════════════════════════════════════════════════════════
async function extractInvoiceFields({ fullText, filePath, engine, pages }) {
  const page1Words = pages && pages[0] && pages[0].words ? pages[0].words : [];
  const format = detectInvoiceFormat(fullText);

  if (format === "NADEC" && page1Words.length) {
    const nadec = await extractNADECInvoiceFieldsPositional(page1Words);
    // N'accepte le résultat NADEC que s'il a effectivement trouvé quelque
    // chose de fiable — sinon repli sur le moteur générique plutôt que de
    // renvoyer une extraction vide (§14 "conserver le support SAGE" : la
    // détection ne doit jamais faire régresser un document qui aurait été
    // correctement lu par l'autre voie).
    if (nadec.invoiceNumber.value || nadec.items.length) return nadec;
  }

  // Repli générique (couvre SAGE ET "UNKNOWN", §13) — le format "UNKNOWN"
  // ne doit jamais bloquer l'extraction : le moteur positionnel générique
  // (label + position, pas de mapping figé) reste le meilleur effort
  // disponible pour un document non identifié, seul le LIBELLÉ de format
  // renvoyé change (jamais faussement annoncé "SAGE").
  if (page1Words.length) {
    const positional = await extractInvoiceFieldsPositional(page1Words, { fullText, filePath, engine, pages });
    if (positional.invoiceNumber.value) return { ...positional, format: format === "UNKNOWN" ? "UNKNOWN" : "SAGE" };
  }
  const linear = await extractInvoiceFieldsLinear({ fullText, filePath, engine, pages });
  return { ...linear, format: format === "UNKNOWN" ? "UNKNOWN" : "SAGE" };
}

module.exports = {
  extractInvoiceNumber,
  extractInvoiceDate,
  extractReference,
  extractCustomer,
  extractTotals,
  extractInvoiceItems,
  extractInvoiceFields,
  extractInvoiceFieldsLinear,
  detectInvoiceFormat,
  extractNADECInvoiceFieldsPositional,
};
