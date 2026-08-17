"use strict";

// Extraction de champs structurés à partir du texte/mots positionnés d'un
// Bon de Livraison (voir deliveryNoteOcr.service.js). Même approche
// regex/heuristique que invoiceFieldExtraction.service.js (dont ce fichier
// réutilise directement la logique de reconstruction de tableau et la liste
// des gouvernorats) — chaque champ renvoie une confiance, une valeur non
// trouvée reste `null`, jamais devinée.

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

// Filet de sécurité final avant enregistrement : un libellé du document ne
// doit JAMAIS se retrouver enregistré comme s'il s'agissait d'une valeur
// (ex. deliveryNumber = "Numéro", truckRegistration = "Construct"). Ne
// devrait normalement plus se produire vu comment chaque champ est
// maintenant extrait (par libellé + position, jamais par ordre linéaire),
// mais reste une vérification structurelle explicitement demandée.
const KNOWN_LABELS = [
  "Numéro",
  "Date",
  "N° téléphone client",
  "Référence",
  "Matricule Fiscal client",
  "Adresse Siège",
  "Bon de livraison",
  "Expédition",
  "Immatricul.",
  "Construct",
  "Chauffeur",
  "Date de livraison",
  "Adresse de livraison",
  "Désignation",
  "Unité",
  "Diam.",
  "Maille",
  "Qté",
  "TOTAL",
  "Produit",
];

// Certains BL imprimés utilisent "=" comme séparateur label/valeur (ex.
// "Immatricul. = VIDE"), pas seulement ":"/"-". "VIDE" est le marqueur
// explicite d'absence de donnée utilisé par ce type de document — traité
// comme une valeur non trouvée (jamais gardé tel quel comme un vrai texte).
function extractLabeled(text, labelPatterns, { maxLength = 200 } = {}) {
  for (const label of labelPatterns) {
    const re = new RegExp(`${label}\\s*[:\\-=]?\\s*([^\\n]{1,${maxLength}})`, "i");
    const m = text.match(re);
    if (m) {
      let value = m[1].trim().replace(/\s{2,}/g, " ");
      if (/^VIDE$/i.test(value)) value = "";
      if (value) return field(value, 0.9);
    }
  }
  return field(null, 0);
}

// Capture le libellé PUIS TOUTES les lignes de valeur qui suivent — jamais
// seulement la première — jusqu'à une ligne vide, une ligne qui ressemble à
// un NOUVEAU libellé ("Mot:" / "Mot =" en début de ligne), ou un marqueur de
// section connu. Nécessaire pour les BL où un seul libellé ("Adresse
// Siège", "Adresse de livraison") est suivi de plusieurs lignes de contenu
// empilées (code client + nom + adresse ; ou une adresse sur 2 lignes) —
// prendre uniquement "le prochain texte OCR" mélangerait ces lignes avec le
// champ suivant.
function captureBlockLines(text, labelPattern, { maxLines = 6 } = {}) {
  const labelRe = new RegExp(`${labelPattern}\\s*[:\\-=]?\\s*`, "i");
  const m = text.match(labelRe);
  if (!m) return [];

  const afterLabel = text.slice(m.index + m[0].length);
  const rawLines = afterLabel.split("\n");
  const isNewLabelLine = (line) => /^[\wÀ-ÿ°ºn'./]{1,30}\s*[:=]/.test(line);
  const sectionMarker = /^(BON\s*DE\s*LIVRAISON|EXP[ÉE]DITION)\b/i;

  const lines = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) break;
    if (lines.length > 0 && (isNewLabelLine(line) || sectionMarker.test(line))) break;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function extractDeliveryNumber(text) {
  return extractLabeled(
    text,
    [
      "BON\\s*DE\\s*LIVRAISON\\s*N[°ºo:]*",
      "B\\.?L\\.?\\s*N[°ºo:]*",
      "N[°ºo]\\s*(?:DE\\s*)?(?:BL|BON)",
      // Repli : certains BL générés par ERP n'utilisent qu'un "Numéro:" nu —
      // exclu s'il précède "téléphone"/"fiscal" pour éviter de capter un
      // autre champ numéroté.
      "NUM[ÉE]RO(?!\\s*(?:DE\\s*)?T[ÉE]L|\\s*FISCAL)",
    ],
    { maxLength: 30 }
  );
}

// Essaie chaque libellé DANS L'ORDRE et ne retient que ceux dont la valeur
// capturée se normalise réellement en date valide — évite qu'un libellé
// composé partiellement reconnu (ex. "Date livraison" matché par "DATE"
// seul) ne capture le mot suivant comme si c'était une date.
function extractDeliveryDate(text) {
  for (const label of ["DATE\\s*(?:DE\\s*)?LIVRAISON", "DATE"]) {
    const labeled = extractLabeled(text, [label], { maxLength: 20 });
    if (labeled.value) {
      const normalized = normalizeDate(labeled.value);
      if (normalized) return field(normalized, 0.9);
    }
  }
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
  // alors le reste de la ligne d'en-tête comme si c'était la référence du
  // document — seul le mot complet "Référence"/"Reference" identifie sans
  // ambiguïté ce champ.
  return extractLabeled(text, ["R[ée]f[ée]rence(?:\\s*client)?"], { maxLength: 40 });
}

function extractCustomerPhone(text) {
  // "(?:\s*client)?" : sans lui, "N° téléphone CLIENT:" matcherait jusqu'à
  // "téléphone" puis capturerait littéralement "client:" comme valeur (même
  // collision que "Matricule Fiscal CLIENT" ailleurs dans ce fichier).
  return extractLabeled(text, ["T[ée]l[ée]?(?:phone)?\\.?(?:\\s*client)?", "GSM", "MOBILE"], { maxLength: 30 });
}

// Priorité : label explicite ("Gouvernorat"/"GOUVERNERATE") > gouvernorat
// trouvé DANS l'adresse client > balayage du texte entier en dernier
// recours (confiance dégressive à chaque repli). Le balayage "n'importe où
// dans le texte" seul est ambigu : un nom de gouvernorat peut apparaître
// dans un autre champ sans rapport (ex. "Route de Tunis" dans une adresse
// de siège social ne signifie pas que le gouvernorat client est Tunis).
function findGovernorateIn(text) {
  if (!text) return null;
  for (const g of GOVERNORATES) {
    if (new RegExp(`\\b${g}\\b`, "i").test(text)) return g;
  }
  return null;
}

// "Adresse Siège" est parfois un simple champ adresse sur une ligne, mais
// sur d'autres BL c'est un BLOC de plusieurs lignes empilées sous un seul
// libellé : code client, puis nom du client, puis l'adresse elle-même
// (aucun sous-libellé) — ex. :
//   Adresse siège:
//   C1745741E
//   STE MK BID SOFT
//   IMM LA PERLA 2
//   3027 SIJOUMI
// La 1re ligne au format "C" + chiffres (+ lettre optionnelle) est le code
// client. S'il reste ≥2 lignes après elle, la suivante est le nom et le
// reste est l'adresse (jointes par ", ") ; s'il n'en reste qu'une, c'est
// l'adresse elle-même (comportement historique pour un simple "Adresse
// Siège: <adresse>" sur une ligne).
function extractHeadOfficeBlock(text) {
  const lines = captureBlockLines(text, "ADRESSE\\s*SI[EÈ]GE");
  const empty = { code: field(null, 0), name: field(null, 0), headOfficeAddress: field(null, 0) };
  if (!lines.length) return empty;

  let idx = 0;
  let code = field(null, 0);
  if (/^C\d+[A-Z]?$/i.test(lines[0])) {
    code = field(lines[0], 0.85);
    idx = 1;
  }

  const remaining = lines.slice(idx);
  if (!remaining.length) return { ...empty, code };
  if (remaining.length === 1) return { code, name: field(null, 0), headOfficeAddress: field(remaining[0], 0.85) };
  return { code, name: field(remaining[0], 0.8), headOfficeAddress: field(remaining.slice(1).join(", "), 0.8) };
}

function extractCustomer(text) {
  // Les libellés composés ("Nom client", "Matricule Fiscal client") sont
  // essayés AVANT le repli nu "CLIENT" : sinon, comme "CLIENT" est une
  // sous-chaîne de "Matricule Fiscal CLIENT", il matcherait cette ligne en
  // premier (si elle précède "Nom client" dans le document) et capturerait
  // le matricule fiscal à la place du nom.
  // Le repli nu "CLIENT" exclut explicitement les contextes composés déjà
  // couverts par d'autres champs ("téléphone client", "Matricule Fiscal
  // client") : sans ces lookbehind, si l'un de ces deux champs contient une
  // VRAIE valeur (pas "VIDE"), le nom du client deviendrait par erreur ce
  // numéro de téléphone ou ce matricule fiscal — la première occurrence du
  // mot "client" dans le texte, peu importe le champ auquel il appartient.
  const labeledName = extractLabeled(
    text,
    [
      "NOM\\s*(?:DU\\s*)?CLIENT",
      "RAISON\\s*SOCIALE",
      "(?<!T[ÉE]L[ÉE]?(?:PHONE)?\\.?\\s)(?<!FISCAL\\s)CLIENT",
    ],
    { maxLength: 100 }
  );
  const taxId = extractLabeled(text, ["C\\s*MF", "MATRICULE\\s*FISCAL(?:\\s*CLIENT)?", "M\\.?F\\.?"], { maxLength: 40 });
  const address = extractLabeled(text, ["ADRESSE(?!\\s*(?:SI[EÈ]GE|(?:DE\\s*)?LIVRAISON))"], { maxLength: 200 });

  const headOfficeBlock = extractHeadOfficeBlock(text);
  // Repli : sur certains BL, le nom du client n'a pas de libellé "Nom
  // client" séparé — il n'apparaît QUE comme 2e ligne du bloc "Adresse
  // Siège" (voir extractHeadOfficeBlock).
  const name = labeledName.value ? labeledName : headOfficeBlock.name;

  const labeledGovernorate = extractLabeled(text, ["GOUVERNORAT", "GOUVERNERATE"], { maxLength: 40 });
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

  return { name, taxId, address, governorate, headOfficeAddress: headOfficeBlock.headOfficeAddress, code: headOfficeBlock.code };
}

// Certains BL répètent/étalent l'adresse de livraison sur plusieurs lignes
// (ex. "STE WW DISPLAY\nTUNIS\nTunisie") — jamais seulement la première
// (voir captureBlockLines). Jointes par "\n" (pas ", ") pour préserver la
// structure visuelle multi-lignes d'origine. `maxLines` volontairement bas :
// une adresse dépasse rarement 3 lignes, ce qui limite le risque de déborder
// sur la section suivante si aucune ligne de séparation n'a été détectée.
function extractDeliveryAddressBlock(text) {
  const lines = captureBlockLines(text, "ADRESSE\\s*(?:DE\\s*)?LIVRAISON", { maxLines: 3 });
  if (!lines.length) return field(null, 0);
  return field(lines.join("\n"), 0.85);
}

function extractDeliveryInfo(text) {
  const truckRegistration = extractLabeled(text, ["IMMATRICUL\\.?(?:ATION)?", "CAMION\\s*N[°ºo:]*"], { maxLength: 30 });
  const manufacturer = extractLabeled(text, ["CONSTRUCT(?:EUR)?\\.?"], { maxLength: 40 });
  const driverName = extractLabeled(text, ["CHAUFFEUR"], { maxLength: 60 });
  const deliveryAddress = extractDeliveryAddressBlock(text);

  return { truckRegistration, manufacturer, driverName, deliveryAddress };
}

function extractTotal(text) {
  const labeled = extractLabeled(text, ["TOTAL(?:\\s*QUANTIT[EÉ])?"], { maxLength: 30 });
  return field(labeled.value ? normalizeNumber(labeled.value) : null, labeled.confidence);
}

// ── TABLEAU PRODUITS (Référence/Désignation/Unité/Diam./Maille/Qté) ──────
// Même structure/raisonnement que invoiceFieldExtraction.service.js — un
// Bon de Livraison n'a ni prix ni taxe, donc pas de colonnes "PU HT"/"Taxe".

const COLUMN_KEYWORDS = [
  { key: "reference", patterns: ["REF", "REFERENCE"] },
  { key: "designation", patterns: ["DESIGNATION", "LIBELLE"] },
  { key: "unit", patterns: ["UNITE", "UNIT"] },
  { key: "diameter", patterns: ["DIAM"] },
  { key: "meshSize", patterns: ["MAILLE", "MESH"] },
  { key: "quantity", patterns: ["QTE", "QTY", "QUANTITE"] },
];

function normalizeHeaderCell(cell) {
  return String(cell || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z]/g, "");
}

function matchColumnKey(headerCell) {
  const norm = normalizeHeaderCell(headerCell);
  if (!norm || norm.length < 2) return null;
  for (const { key, patterns } of COLUMN_KEYWORDS) {
    // `norm.includes(p)` (l'en-tête contient le mot-clé, ex. "REFERENCECLIENT"
    // contient "REFERENCE") est sûr quelle que soit la longueur. `p.includes(norm)`
    // (norm est une ABRÉVIATION du mot-clé, ex. "REF" dans "REFERENCE") est
    // dangereux si `norm` est très court : un code client comme "C1745741E",
    // une fois les chiffres retirés par normalizeHeaderCell, se réduit à "CE"
    // — qui se trouve être une sous-chaîne de "REFERENCE" par pur hasard. On
    // exige donc au moins 3 caractères pour cette direction (couvre tous les
    // en-têtes réels : REF/QTE/DIAM/UNIT/MAILLE...).
    if (patterns.some((p) => norm.includes(p) || (norm.length >= 3 && p.includes(norm)))) return key;
  }
  return null;
}

const NORMALIZED_KNOWN_LABELS = new Set(KNOWN_LABELS.map(normalizeHeaderCell));

function isOcrLabel(value) {
  if (!value) return false;
  return NORMALIZED_KNOWN_LABELS.has(normalizeHeaderCell(String(value)));
}

function sanitizeFieldAgainstLabels(f) {
  if (f && typeof f.value === "string" && isOcrLabel(f.value)) return field(null, 0);
  return f;
}

// Sur un tableau produits VIDE (aucune vraie ligne de données), la rangée
// d'en-tête peut être imprimée comme PLUSIEURS mots-clés de colonnes fusionnés
// en une seule cellule ("Référence Diam. Maille\tUnitè Qté") plutôt qu'un
// unique libellé — `isOcrLabel` (comparaison exacte à une entrée connue) ne
// la détecte pas. On découpe donc la valeur en tokens (espaces/tabulations)
// AVANT de tester chacun via matchColumnKey — jamais la valeur entière
// d'un coup, sinon la jonction de deux mots réels sans espace (ex.
// "VERRE"+"FINI" → "VERREFINI") peut faire apparaître un mot-clé par pur
// hasard aux frontières (piège déjà rencontré avec "REF" dans "VERRE FINI").
function looksLikeConcatenatedHeaderRow(value) {
  if (!value) return false;
  const tokens = String(value).split(/[\s\t]+/).filter(Boolean);
  if (tokens.length < 2) return false;
  return tokens.filter((t) => matchColumnKey(t)).length >= 2;
}

function sanitizeItemAgainstLabels(item) {
  const clean = { ...item };
  for (const key of ["reference", "designation", "unit", "meshSize", "diameter"]) {
    if (typeof clean[key] !== "string") continue;
    if (isOcrLabel(clean[key]) || looksLikeConcatenatedHeaderRow(clean[key])) delete clean[key];
  }
  return clean;
}

// Après nettoyage, une ligne qui ne contenait QUE des libellés d'en-tête
// (tableau produits vide dont la rangée d'en-tête a été mal identifiée comme
// une donnée) ne doit pas devenir un "produit" fantôme — même seuil que celui
// utilisé pour retenir la ligne au départ (buildItemFromCells, filled >= 2).
function hasEnoughRealItemFields(item) {
  return Object.keys(item).filter((k) => k !== "confidence").length >= 2;
}

const NUMERIC_ITEM_FIELDS = new Set(["quantity"]);

function buildItemFromCells(columnKeys, cells) {
  const item = {};
  let filled = 0;
  columnKeys.forEach((key, i) => {
    if (!key) return;
    const raw = (cells[i] || "").trim();
    // "VIDE" est le marqueur explicite d'absence de donnée — jamais gardé
    // comme valeur littérale (ex. meshSize ne doit jamais devenir "VIDE").
    if (!raw || /^VIDE$/i.test(raw)) return;
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

async function extractItemsFromPdfTable(filePath) {
  const fs = require("fs");
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  try {
    const result = await parser.getTable();
    const items = [];
    for (const page of result.pages || []) {
      for (const table of page.tables || []) {
        if (!table.length) continue;
        const columnKeys = table[0].map((h) => matchColumnKey(h));
        if (!columnKeys.some(Boolean)) continue;
        for (let r = 1; r < table.length; r++) {
          const { item, filled } = buildItemFromCells(columnKeys, table[r]);
          if (filled >= 2) items.push({ ...item, confidence: Math.min(0.9, 0.4 + filled * 0.12) });
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

  let headerIdx = -1;
  let bestMatches = 0;
  rows.forEach((row, i) => {
    const matches = row.words.filter((w) => matchColumnKey(w.text)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      headerIdx = i;
    }
  });
  if (headerIdx === -1 || bestMatches < 2) return [];

  const columns = rows[headerIdx].words
    .map((w) => ({ key: matchColumnKey(w.text), left: w.left, right: w.left + w.width }))
    .filter((c) => c.key);
  columns.sort((a, b) => a.left - b.left);
  columns.forEach((c, i) => {
    c.rangeStart = i === 0 ? -Infinity : (columns[i - 1].right + c.left) / 2;
    c.rangeEnd = i === columns.length - 1 ? Infinity : (c.right + columns[i + 1].left) / 2;
  });

  const items = [];
  const stopWords = ["TOTAL"];
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
    if (filled >= 2) items.push({ ...item, confidence: Math.min(0.85, 0.3 + filled * 0.12) });
  }
  return items;
}

// Repli pour les BL générés sans tableau bordé, où le produit est listé en
// une seule ligne "Référence / Désignation / ..." par champ (mise en page
// "étiquette : valeur" empilée, plutôt qu'un vrai tableau) — un seul
// produit est reconstruit à partir de ces libellés isolés. Ne s'applique
// que si le tableau/mots positionnés n'ont rien trouvé.
function extractSingleItemFromLabels(text) {
  if (!text) return [];
  // Chercher les champs du produit uniquement APRÈS le marqueur "Produit"
  // s'il existe : sinon un champ DOCUMENT du même nom apparaissant plus tôt
  // dans le texte (ex. "Référence:" au niveau document, souvent VIDE) serait
  // trouvé EN PREMIER par extractLabeled — qui ne cherche qu'UNE occurrence
  // par motif — empêchant à jamais d'atteindre la vraie référence du produit
  // plus loin dans le texte.
  const productMarker = text.match(/\bPRODUIT\b/i);
  const scoped = productMarker ? text.slice(productMarker.index) : text;

  const reference = extractLabeled(scoped, ["R[ée]f[ée]rence"], { maxLength: 40 });
  const designation = extractLabeled(scoped, ["D[ée]signation", "LIBELL[ÉE]"], { maxLength: 150 });
  const unit = extractLabeled(scoped, ["UNIT[ÉE]?"], { maxLength: 20 });
  const diameterRaw = extractLabeled(scoped, ["DIAM(?:[ÈE]TRE|ETER|\\.)?"], { maxLength: 20 });
  const meshRaw = extractLabeled(scoped, ["MESH\\s*SIZE", "MAILLE"], { maxLength: 20 });
  const quantityRaw = extractLabeled(scoped, ["QUANTIT[ÉEY]", "QT[ÉE]\\.?"], { maxLength: 20 });

  const item = {};
  let filled = 0;
  if (reference.value) {
    item.reference = reference.value;
    filled += 1;
  }
  if (designation.value) {
    item.designation = designation.value;
    filled += 1;
  }
  if (unit.value) {
    item.unit = unit.value;
    filled += 1;
  }
  if (diameterRaw.value) {
    const v = normalizeDiameter(diameterRaw.value);
    if (v) {
      item.diameter = v;
      filled += 1;
    }
  }
  if (meshRaw.value) {
    item.meshSize = normalizeMeshSize(meshRaw.value) || meshRaw.value;
    filled += 1;
  }
  if (quantityRaw.value) {
    const v = normalizeNumber(quantityRaw.value);
    if (v !== null) {
      item.quantity = v;
      filled += 1;
    }
  }

  if (filled < 2) return [];
  return [{ ...item, confidence: Math.min(0.85, 0.35 + filled * 0.1) }];
}

// Repli pour les BL qui listent le tableau produits en texte empilé SANS
// bordures NI mots positionnés exploitables (ni tableau bordé pour
// extractItemsFromPdfTable, ni bbox pour extractItemsFromWords) — mais avec
// PLUSIEURS lignes de produits (contrairement à extractSingleItemFromLabels,
// qui ne reconstruit qu'UN seul produit). Détecte un bloc d'en-têtes
// consécutifs ("Référence"/"Désignation"/... chacun sur sa propre ligne),
// PUIS regroupe les lignes de valeurs suivantes en paquets de la même
// taille que le nombre d'en-têtes détectés — un paquet = une ligne du
// tableau, quel que soit le nombre de lignes (1, 2, 10...). Jamais l'ordre
// linéaire du DOCUMENT ENTIER : uniquement la position DANS ce bloc, par
// rapport à l'en-tête qui le définit.
// `matchColumnKey` fait un match par SOUS-CHAÎNE (ex. "REF" ⊂ un en-tête
// tronqué "Référen..."), ce qui est sûr sur de VRAIES cellules d'en-tête
// (courtes, vocabulaire contrôlé) mais dangereux ici : ce scanner examine
// CHAQUE ligne du bloc produit, y compris de longues désignations libres
// ("PROMECHE EN FIBRE DE VERRE FINI" contient "REF" par pur hasard, dans
// "...VERRE FINI"). Un plafond de longueur écarte ces faux positifs tout en
// laissant passer les en-têtes réels (tous ≤ 15 caractères normalisés).
function matchFlatColumnHeader(line) {
  const norm = normalizeHeaderCell(line);
  if (!norm || norm.length < 2 || norm.length > 15) return null;
  return matchColumnKey(line);
}

function extractItemsFromFlatColumnBlock(text) {
  if (!text) return [];
  const productMarker = text.match(/\bPRODUIT\b/i);
  const scoped = productMarker ? text.slice(productMarker.index) : text;
  const lines = scoped.split("\n").map((l) => l.trim());

  // Cherche la plus longue séquence consécutive de lignes reconnues comme
  // en-têtes de colonne (≥2, pour écarter un simple champ isolé type
  // "Diam." qui apparaîtrait seul ailleurs) ; tolère des lignes vides entre
  // deux en-têtes (mise en page aérée).
  let headerStart = -1;
  let headerEnd = -1;
  let headerKeys = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const firstKey = matchFlatColumnHeader(lines[i]);
    if (!firstKey) continue;
    const seq = [firstKey];
    let j = i + 1;
    let lastNonEmpty = i;
    while (j < lines.length) {
      if (!lines[j]) {
        j++;
        continue;
      }
      const k = matchFlatColumnHeader(lines[j]);
      if (!k || seq.includes(k)) break;
      seq.push(k);
      lastNonEmpty = j;
      j++;
    }
    if (seq.length >= 2 && seq.length > headerKeys.length) {
      headerKeys = seq;
      headerStart = i;
      headerEnd = lastNonEmpty;
    }
  }
  if (headerKeys.length < 2) return [];

  const valueLines = lines.slice(headerEnd + 1).filter(Boolean);
  const stopWords = ["TOTAL"];

  const items = [];
  for (let start = 0; start + headerKeys.length <= valueLines.length; start += headerKeys.length) {
    const chunk = valueLines.slice(start, start + headerKeys.length);
    if (stopWords.some((s) => normalizeHeaderCell(chunk[0]).includes(s))) break;
    const { item, filled } = buildItemFromCells(headerKeys, chunk);
    if (filled < 2) break; // paquet incomplet/non exploitable → fin du tableau
    items.push({ ...item, confidence: Math.min(0.85, 0.3 + filled * 0.1) });
  }
  return items;
}

async function extractDeliveryItems({ filePath, engine, pages, fullText }) {
  if (engine === "pdf-text") {
    const items = await extractItemsFromPdfTable(filePath);
    if (items.length) return items;
  }
  const allWords = (pages || []).flatMap((p) => p.words || []);
  const wordItems = extractItemsFromWords(allWords);
  if (wordItems.length) return wordItems;
  const flatColumnItems = extractItemsFromFlatColumnBlock(fullText);
  if (flatColumnItems.length) return flatColumnItems;
  return extractSingleItemFromLabels(fullText);
}

async function extractDeliveryNoteFieldsLinear({ fullText, filePath, engine, pages }) {
  // Le champ "Référence" DOCUMENT (customerReference) partage son libellé
  // avec le "Référence" du PRODUIT dans la mise en page "étiquette : valeur"
  // empilée sans tableau (voir extractSingleItemFromLabels) — sur un
  // document qui n'a PAS de Référence au niveau document, une recherche sur
  // tout le texte capterait par erreur celle de l'unique produit. On ne
  // cherche donc le champ document que dans le texte AVANT la section
  // "Produit" (repli sur le texte entier si aucun marqueur "Produit" trouvé,
  // ce qui préserve le comportement des documents tabulaires existants).
  const productMarker = fullText.match(/\bPRODUIT\b/i);
  const headerText = productMarker ? fullText.slice(0, productMarker.index) : fullText;

  const customer = extractCustomer(fullText);
  const delivery = extractDeliveryInfo(fullText);
  const items = await extractDeliveryItems({ filePath, engine, pages, fullText });

  return {
    deliveryNumber: sanitizeFieldAgainstLabels(extractDeliveryNumber(fullText)),
    deliveryDate: extractDeliveryDate(fullText),
    customerPhone: sanitizeFieldAgainstLabels(extractCustomerPhone(fullText)),
    reference: sanitizeFieldAgainstLabels(extractReference(headerText)),
    customer: {
      ...customer,
      name: sanitizeFieldAgainstLabels(customer.name),
      taxId: sanitizeFieldAgainstLabels(customer.taxId),
      code: sanitizeFieldAgainstLabels(customer.code),
      headOfficeAddress: sanitizeFieldAgainstLabels(customer.headOfficeAddress),
    },
    delivery: {
      ...delivery,
      truckRegistration: sanitizeFieldAgainstLabels(delivery.truckRegistration),
      manufacturer: sanitizeFieldAgainstLabels(delivery.manufacturer),
      driverName: sanitizeFieldAgainstLabels(delivery.driverName),
      deliveryAddress: sanitizeFieldAgainstLabels(delivery.deliveryAddress),
    },
    total: extractTotal(fullText),
    items: items.map(sanitizeItemAgainstLabels).filter(hasEnoughRealItemFields),
  };
}

// ══════════════════════════════════════════════════════════════════════
// EXTRACTION POSITIONNELLE (coordonnées X/Y réelles) — stratégie PRINCIPALE
// ══════════════════════════════════════════════════════════════════════
// "CORRECTION CRITIQUE — MAPPING DES DONNÉES DU BON DE LIVRAISON" : un vrai
// document (export Sage) a révélé que l'extraction ci-dessus, bien que
// basée sur des libellés (jamais l'ordre linéaire OCR brut), reste piégée
// par les mises en page à PLUSIEURS COLONNES — `pdf-parse.getText()`
// aplatit tout en un flux qui entrelace les colonnes hors de l'ordre de
// lecture visuel (ex. "N° téléphone client" se retrouve juste avant le code
// client d'une colonne voisine, à 156pt de distance, sans rapport). Seules
// les coordonnées X/Y (via pdfjs-dist pour le texte natif, ou les bbox
// Tesseract pour l'OCR image) permettent de rattacher un libellé à sa VRAIE
// valeur — jamais "le texte suivant". Repli sur extractDeliveryNoteFieldsLinear
// uniquement si aucun mot positionné n'est disponible ou rien n'a été trouvé.

// Reprend les MÊMES motifs déjà validés par l'extraction texte linéaire
// (extractDeliveryNumber/extractCustomer/etc. ci-dessus) — appliqués ici à
// un seul MOT positionné à la fois plutôt qu'à une ligne de texte entière.
// "name"/"address" n'ont pas d'équivalent dans le document réel qui a motivé
// cette réécriture (bloc "Adresse Siège" uniquement), mais restent
// nécessaires : d'autres BL de ce projet utilisent "Nom client"/"Adresse"
// comme libellés directs — les omettre romprait le repérage de fin de champ
// (stop-detection) sur ces documents, laissant une recherche "en dessous"
// déborder indéfiniment jusqu'au bas de la page.
const POSITIONAL_LABELS = {
  deliveryNumber: /BON\s*DE\s*LIVRAISON\s*N[°ºo:]*|B\.?L\.?\s*N[°ºo:]*|N[°ºo]\s*(?:DE\s*)?(?:BL|BON)|NUM[ÉE]RO(?!\s*(?:DE\s*)?T[ÉE]L|\s*FISCAL)/i,
  documentDate: /^DATE$/i,
  phone: /T[ÉE]L[ÉE]?(?:PHONE)?\.?(?:\s*CLIENT)?|^GSM$|^MOBILE$/i,
  reference: /^R[ÉE]F[ÉE]RENCE(?:\s*CLIENT)?$/i,
  taxId: /^C\s*MF$|MATRICULE\s*FISCAL(?:\s*CLIENT)?/i,
  name: /NOM\s*(?:DU\s*)?CLIENT|RAISON\s*SOCIALE/i,
  address: /^ADRESSE$/i,
  headOffice: /ADRESSE\s*SI[EÈ]GE/i,
  governorate: /GOUVERNORAT|GOUVERNERATE/i,
  deliveryDate: /DATE\s*(?:DE\s*)?LIVRAISON/i,
  deliveryAddress: /ADRESSE\s*(?:DE\s*)?LIVRAISON/i,
  truckRegistration: /IMMATRICUL\.?(?:ATION)?|^CAMION\s*N[°ºo:]*$/i,
  manufacturer: /^CONSTRUCT(?:EUR)?\.?$/i,
  driverName: /^CHAUFFEUR$/i,
  total: /^TOTAL(?:\s*QUANTIT[EÉ])?$/i,
  // "CLIENT" nu : seulement en tout dernier recours, jamais s'il s'agit en
  // réalité de "Matricule Fiscal CLIENT"/"téléphone CLIENT" (même piège que
  // dans extractCustomer côté texte linéaire).
  bareClient: /(?<!T[ÉE]L[ÉE]?(?:PHONE)?\.?\s)(?<!FISCAL\s)^CLIENT$/i,
};
const POSITIONAL_SECTION_MARKERS = [
  /BON\s*DE\s*LIVRAISON/i,
  /EXP[ÉE]DITION/i,
  /^PAGE$/i,
  /SAGE/i,
  /^TABLEAU$/i,
  /^PRODUIT$/i,
];

// Certains BL impriment "Libellé:"/"Libellé =" en mot séparé de sa valeur,
// d'autres impriment "Libellé: Valeur" ou "Libellé = Valeur" comme UNE SEULE
// chaîne (un seul appel .text(), ex. "Immatricul. = 456 TUN 7890", "Date:
// 14/08/2026"). Dans les deux cas, seule la partie AVANT le premier séparateur
// doit être testée contre les patterns de libellé (souvent ancrés `^...$`) —
// sinon aucune correspondance n'est possible pour les documents "combinés".
function positionalLabelPrefix(text) {
  if (!text) return "";
  const trimmed = text.trim().replace(/[:=]\s*$/, "");
  const sepIdx = trimmed.search(/[:=]/);
  return sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx).trim();
}

function isPositionalLabel(text) {
  if (!text) return false;
  const normalized = positionalLabelPrefix(text);
  if (Object.values(POSITIONAL_LABELS).some((re) => re.test(normalized))) return true;
  if (POSITIONAL_SECTION_MARKERS.some((re) => re.test(normalized))) return true;
  return Boolean(matchColumnKey(normalized)); // en-têtes du tableau produits (Référence/Désignation/...)
}

function findAllPositionalLabels(words) {
  return words.filter((w) => isPositionalLabel(w.text));
}

// PASSE 1 — paires "libellé : valeur" sur la MÊME rangée (tolérance Y
// serrée ~2.5pt) : signal fort et sans ambiguïté (ex. "Construct" +
// "CAMION" à 0.2pt d'écart en Y). Réclamées AVANT la passe 2 pour qu'une
// valeur ainsi identifiée ne puisse plus être aspirée par un autre libellé
// plus bas sur la page dont la colonne se trouverait, par coïncidence, à
// une distance X comparable.
function claimPositionalSameRowValues(words, labels, claimed) {
  const result = new Map();
  for (const label of labels) {
    // Un plafond de distance ne s'applique QUE si un autre libellé partage
    // à peu près la même rangée Y (risque réel de confusion) — un libellé
    // isolé sur sa rangée (ex. "TOTAL", montant aligné loin à droite) n'a
    // aucune ambiguïté possible, quelle que soit la distance.
    const hasRowSiblings = labels.some((o) => o !== label && Math.abs(o.top - label.top) < 20);
    const maxGap = hasRowSiblings ? 70 : Infinity;

    const sameRow = words
      .filter((w) => !claimed.has(w) && w !== label && !isPositionalLabel(w.text))
      .filter((w) => Math.abs(w.top - label.top) <= 2.5 && w.left > label.left + label.width - 5)
      .filter((w) => w.left - (label.left + label.width) <= maxGap)
      .sort((a, b) => a.left - b.left);
    if (!sameRow.length) continue;

    // Ne prend que le mot le plus proche et ses voisins IMMÉDIATS (écart
    // < 20pt) — un grand écart signale une AUTRE colonne sur la même rangée.
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
// DESSOUS dans la même colonne (X proche), en excluant tout mot déjà
// réclamé en passe 1, bornée par le PROCHAIN libellé de cette colonne
// (tolérance ÉTROITE, pour ne jamais sauter jusqu'à une tout autre section
// de la page) et par la compétition avec les libellés "voisins" (même
// rangée que CE libellé — ex. "Numéro"/"Date" sur la même ligne d'en-tête).
function findPositionalValueLines(words, labelWord, allLabels, claimed, { xTolerance = 150, maxGapY = 40, maxLines = 6 } = {}) {
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
    if (row.items.some((it) => isPositionalLabel(it.text))) break;
    const text = row.items.map((it) => it.text).join(" ");
    if (!/^VIDE$/i.test(text)) lines.push(text);
    row.items.forEach((it) => claimed.add(it));
    lastY = row.top;
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function buildPositionalExtractor(words) {
  const allLabels = findAllPositionalLabels(words);
  const claimed = new Set();
  const sameRowValues = claimPositionalSameRowValues(words, allLabels, claimed);

  return function extractPositionalField(pattern, opts) {
    opts = opts || {};
    const candidateLabels = opts.beforeY != null ? allLabels.filter((w) => w.top < opts.beforeY) : allLabels;
    const label = candidateLabels.find((w) => pattern.test(positionalLabelPrefix(w.text)));
    if (!label) return field(null, 0);

    // Le libellé et sa valeur peuvent être imprimés comme UNE SEULE chaîne
    // ("Immatricul. = 456 TUN 7890", "Bon de livraison n: BL-123") plutôt
    // qu'en mots séparés — extraire la valeur EMBARQUÉE dans le mot du
    // libellé lui-même est prioritaire sur toute recherche de mot voisin.
    const embeddedMatch = label.text.match(/[:=]\s*(\S.*)$/);
    if (embeddedMatch) {
      const embedded = embeddedMatch[1].trim();
      return /^VIDE$/i.test(embedded) ? field(null, 0) : field(embedded, 0.9);
    }

    if (sameRowValues.has(label)) {
      const v = sameRowValues.get(label);
      return /^VIDE$/i.test(v) ? field(null, 0) : field(v, 0.9);
    }
    const lines = findPositionalValueLines(words, label, allLabels, claimed, opts);
    return lines.length ? field(lines.join("\n"), 0.85) : field(null, 0);
  };
}

function extractCustomerPositional(words, extractPositionalField) {
  const taxId = extractPositionalField(POSITIONAL_LABELS.taxId, {});
  const address = extractPositionalField(POSITIONAL_LABELS.address, {});
  const headOfficeRaw = extractPositionalField(POSITIONAL_LABELS.headOffice, {});

  // Même découpage code/nom/adresse que la version texte linéaire (voir
  // extractHeadOfficeBlock), appliqué aux lignes reconstruites par position.
  const blockLines = headOfficeRaw.value ? headOfficeRaw.value.split("\n") : [];
  let idx = 0;
  let code = field(null, 0);
  if (blockLines[0] && /^C\d+[A-Z]?$/i.test(blockLines[0])) {
    code = field(blockLines[0], 0.85);
    idx = 1;
  }
  const remaining = blockLines.slice(idx);
  let blockName = field(null, 0);
  let headOfficeAddress = field(null, 0);
  if (remaining.length >= 2) {
    blockName = field(remaining[0], 0.8);
    headOfficeAddress = field(remaining.slice(1).join(", "), 0.8);
  } else if (remaining.length === 1) {
    headOfficeAddress = field(remaining[0], 0.85);
  }

  // Un libellé "Nom client"/"Raison sociale" (ou, en tout dernier recours,
  // "Client" nu) est prioritaire sur le nom déduit du bloc "Adresse Siège" —
  // ce dernier ne sert que de repli quand aucun libellé de nom dédié
  // n'existe sur le document (comme extractCustomer côté texte linéaire).
  const labeledName = extractPositionalField(POSITIONAL_LABELS.name, {});
  const bareClientName = labeledName.value ? field(null, 0) : extractPositionalField(POSITIONAL_LABELS.bareClient, {});
  const name = labeledName.value ? labeledName : bareClientName.value ? bareClientName : blockName;

  const labeledGovernorate = extractPositionalField(POSITIONAL_LABELS.governorate, {});
  let governorate = field(null, 0);
  if (labeledGovernorate.value) {
    governorate = field(findGovernorateIn(labeledGovernorate.value) || labeledGovernorate.value, 0.9);
  } else {
    const inAddress = findGovernorateIn(address.value);
    if (inAddress) governorate = field(inAddress, 0.75);
    else {
      const wholeText = words.map((w) => w.text).join(" ");
      const anywhere = findGovernorateIn(wholeText);
      if (anywhere) governorate = field(anywhere, 0.6);
    }
  }

  return { name, taxId, address, governorate, headOfficeAddress, code };
}

async function extractDeliveryNoteFieldsPositional(page1Words, { fullText, filePath, engine, pages }) {
  const extractPositionalField = buildPositionalExtractor(page1Words);

  const deliveryNumber = extractPositionalField(POSITIONAL_LABELS.deliveryNumber, {});

  // "Date" (document) et "Date de livraison" alimentent le MÊME champ —
  // priorité à "Date de livraison" si présente, "Date" en repli.
  const dateFromDeliverySection = extractPositionalField(POSITIONAL_LABELS.deliveryDate, {});
  const dateFromDocument = extractPositionalField(POSITIONAL_LABELS.documentDate, {});
  const rawDate = dateFromDeliverySection.value || dateFromDocument.value;
  const dateConfidence = dateFromDeliverySection.value ? dateFromDeliverySection.confidence : dateFromDocument.confidence;
  const deliveryDate = rawDate ? field(normalizeDate(rawDate), dateConfidence) : field(null, 0);

  const phone = extractPositionalField(POSITIONAL_LABELS.phone, {});

  // Le "Référence" DOCUMENT (customerReference) partage son libellé avec le
  // "Référence" du PRODUIT dans la mise en page "étiquette : valeur" empilée
  // sans tableau (voir extractSingleItemFromLabels côté texte linéaire) — sur
  // un document qui n'a PAS de Référence au niveau document, une recherche
  // sans borne capterait par erreur celle de l'unique produit. On ne cherche
  // donc le libellé document que parmi les mots AVANT le marqueur "Produit"
  // (repli sur toute la page si aucun marqueur trouvé).
  const productMarkerWord = page1Words.find((w) => /^PRODUIT$/i.test(positionalLabelPrefix(w.text)));
  const reference = extractPositionalField(
    POSITIONAL_LABELS.reference,
    productMarkerWord ? { beforeY: productMarkerWord.top } : {}
  );
  const customer = extractCustomerPositional(page1Words, extractPositionalField);

  const truckRegistration = extractPositionalField(POSITIONAL_LABELS.truckRegistration, {});
  const manufacturer = extractPositionalField(POSITIONAL_LABELS.manufacturer, {});
  const driverName = extractPositionalField(POSITIONAL_LABELS.driverName, {});
  const deliveryAddress = extractPositionalField(POSITIONAL_LABELS.deliveryAddress, { maxGapY: 45 });

  const totalRaw = extractPositionalField(POSITIONAL_LABELS.total, {});
  const total = field(totalRaw.value ? normalizeNumber(totalRaw.value) : null, totalRaw.confidence);

  let items = extractItemsFromWords(page1Words);
  if (!items.length) items = await extractDeliveryItems({ filePath, engine, pages, fullText });

  return {
    deliveryNumber: sanitizeFieldAgainstLabels(deliveryNumber),
    deliveryDate,
    customerPhone: sanitizeFieldAgainstLabels(phone),
    reference: sanitizeFieldAgainstLabels(reference),
    customer: {
      ...customer,
      name: sanitizeFieldAgainstLabels(customer.name),
      taxId: sanitizeFieldAgainstLabels(customer.taxId),
      code: sanitizeFieldAgainstLabels(customer.code),
      headOfficeAddress: sanitizeFieldAgainstLabels(customer.headOfficeAddress),
    },
    delivery: {
      truckRegistration: sanitizeFieldAgainstLabels(truckRegistration),
      manufacturer: sanitizeFieldAgainstLabels(manufacturer),
      driverName: sanitizeFieldAgainstLabels(driverName),
      deliveryAddress: sanitizeFieldAgainstLabels(deliveryAddress),
    },
    total,
    items: items.map(sanitizeItemAgainstLabels).filter(hasEnoughRealItemFields),
  };
}

// Point d'entrée : essaie l'extraction POSITIONNELLE (fiable sur les mises
// en page à colonnes multiples) si des mots avec coordonnées sont
// disponibles pour la 1re page ET qu'elle trouve effectivement quelque
// chose ; sinon, repli sur l'extraction texte linéaire historique (mots
// absents — PDF illisible par pdfjs, format non-OCR-able, etc.).
async function extractDeliveryNoteFields({ fullText, filePath, engine, pages }) {
  const page1Words = pages && pages[0] && pages[0].words ? pages[0].words : [];
  if (page1Words.length) {
    const positional = await extractDeliveryNoteFieldsPositional(page1Words, { fullText, filePath, engine, pages });
    // Le repérage de la référence (nombre de livraison) est le signal le
    // plus fiable que les libellés de CE document sont bien reconnus comme
    // des mots ISOLÉS (pas "Label: valeur" écrit en une seule chaîne, comme
    // sur certains anciens BL de test — auquel cas rien ne serait jamais
    // trouvé par mot isolé, mais un tableau positionné pourrait quand même
    // être détecté par coïncidence : items.length seul n'est pas un signal
    // suffisant pour committer à cette stratégie).
    if (positional.deliveryNumber.value) return positional;
  }
  return extractDeliveryNoteFieldsLinear({ fullText, filePath, engine, pages });
}

module.exports = {
  extractDeliveryNumber,
  extractDeliveryDate,
  extractCustomerPhone,
  extractReference,
  extractCustomer,
  extractDeliveryInfo,
  extractTotal,
  extractDeliveryItems,
  extractDeliveryNoteFields,
};
