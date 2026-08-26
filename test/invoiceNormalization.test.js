"use strict";

// Tests unitaires purs (aucune DB/réseau) des règles de normalisation OCR
// exactement telles que spécifiées par l'utilisateur.

const {
  normalizeNumber,
  normalizeDate,
  normalizeMeshSize,
  normalizeDiameter,
  normalizeUnitAndDiameter,
} = require("../src/modules/finance/services/invoiceNormalization.service");

describe("invoiceNormalization.service", () => {
  describe("normalizeNumber", () => {
    test.each([
      ["2 500", 2500],
      ["2.500", 2500], // contexte français : point = séparateur de milliers
      ["2 500,50", 2500.5],
      ["1 250,50", 1250.5],
      ["1.250,50", 1250.5],
      ["1250,50", 1250.5],
      ["12.50", 12.5], // décimal réel, jamais confondu avec un séparateur de milliers
      ["31250,00", 31250],
    ])("%s -> %s", (input, expected) => {
      expect(normalizeNumber(input)).toBeCloseTo(expected, 2);
    });

    test.each([[null], [undefined], [""], ["   "], ["abc"]])("valeur illisible (%s) -> null, jamais 0", (input) => {
      expect(normalizeNumber(input)).toBeNull();
    });
  });

  describe("normalizeDate", () => {
    test("14/08/2026 -> 2026-08-14", () => {
      expect(normalizeDate("14/08/2026")).toBe("2026-08-14");
    });
    test("14-08-2026 -> 2026-08-14", () => {
      expect(normalizeDate("14-08-2026")).toBe("2026-08-14");
    });
    test("14.08.2026 -> 2026-08-14", () => {
      expect(normalizeDate("14.08.2026")).toBe("2026-08-14");
    });
    test("déjà ISO -> inchangé", () => {
      expect(normalizeDate("2026-08-14")).toBe("2026-08-14");
    });
    test("texte non-date -> null, jamais devinée", () => {
      expect(normalizeDate("pas une date")).toBeNull();
    });
    test("mois/jour hors bornes -> null", () => {
      expect(normalizeDate("32/13/2026")).toBeNull();
    });
  });

  describe("normalizeMeshSize", () => {
    test.each([
      ["100/100", "100X100"],
      ["85/50", "85X50"],
      ["85*50", "85X50"],
      ["85 x 50", "85X50"],
      ["85×50", "85X50"],
    ])("%s -> %s", (input, expected) => {
      expect(normalizeMeshSize(input)).toBe(expected);
    });

    test("format non reconnu -> null", () => {
      expect(normalizeMeshSize("n'importe quoi")).toBeNull();
    });
  });

  describe("normalizeDiameter", () => {
    test('"Ø 6" -> "6"', () => {
      expect(normalizeDiameter("Ø 6")).toBe("6");
    });
    test('"6 mm" -> "6"', () => {
      expect(normalizeDiameter("6 mm")).toBe("6");
    });
    test("vide -> null", () => {
      expect(normalizeDiameter("")).toBeNull();
    });
  });

  // §CORRECTION EXTRACTION — SÉPARATION UNITÉ / DIAMÈTRE — exactement les
  // cas obligatoires du ticket (§12), jamais "04" reformaté en "4".
  describe("normalizeUnitAndDiameter", () => {
    test.each([
      ["M² 10", "M²", "10"],
      ["ML 04", "ML", "04"],
      ["ML 08", "ML", "08"],
      ["ML 12", "ML", "12"],
      ["M² 06", "M²", "06"],
      ["ML 05", "ML", "05"],
      ["M² 08", "M²", "08"],
    ])("%s -> unit=%s, diameter=%s (fusionné)", (input, expectedUnit, expectedDiameter) => {
      const { unit, diameter } = normalizeUnitAndDiameter(input, null);
      expect(unit).toBe(expectedUnit);
      expect(diameter).toBe(expectedDiameter); // jamais "04" -> "4"
    });

    test.each([
      ["ML", "ML"],
      ["KG", "KG"],
      ["M²", "M²"],
      ["LITRE", "LITRE"],
    ])("%s (pas de diamètre) -> unit=%s, diameter=null, jamais inventé", (input, expectedUnit) => {
      const { unit, diameter } = normalizeUnitAndDiameter(input, null);
      expect(unit).toBe(expectedUnit);
      expect(diameter).toBeNull();
    });

    // §6/§8 : le document a déjà des colonnes séparées — jamais retouché,
    // jamais reconstruit en "M² 08".
    test("déjà séparé (Unité=M², Diam.=08) -> inchangé", () => {
      const { unit, diameter } = normalizeUnitAndDiameter("M²", "08");
      expect(unit).toBe("M²");
      expect(diameter).toBe("08");
    });

    // Unité inconnue devant un nombre (ex. une désignation mal alignée) —
    // jamais scindée à tort, jamais de diamètre inventé.
    test("préfixe non reconnu -> jamais séparé", () => {
      const { unit, diameter } = normalizeUnitAndDiameter("XYZ 10", null);
      expect(unit).toBe("XYZ 10");
      expect(diameter).toBeNull();
    });

    test("null/vide -> null", () => {
      expect(normalizeUnitAndDiameter(null, null)).toEqual({ unit: null, diameter: null });
      expect(normalizeUnitAndDiameter("", "")).toEqual({ unit: null, diameter: null });
    });
  });
});
