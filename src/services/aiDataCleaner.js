function isFakeValue(value) {
  if (!value) return true;

  const v = value.toLowerCase().trim();

  const blacklist = [
    "test", "demo", "aaa", "bbb", "ccc",
    "xxx", "zzz", "abc", "123", "qwerty"
  ];

  /// 🔥 EXACT
  if (blacklist.includes(v)) return true;

  /// 🔥 CONTAINS (ex: test123, demo_company)
  if (blacklist.some(word => v.includes(word))) return true;

  /// 🔥 uniquement chiffres
  if (/^\d+$/.test(v)) return true;

  /// 🔥 répétition (aaaaa)
  if (/^(.)\1+$/.test(v)) return true;

  /// 🔥 pas de voyelles
  if (!/[aeiouy]/.test(v)) return true;

  /// 🔥 trop court
  if (v.length < 3) return true;

  return false;
}

/// 🔥 Détection nom entreprise réaliste
function looksLikeCompany(name) {
  if (!name) return false;

  const words = name.trim().split(" ");
  return words.length >= 2; // ex: "ABC Company"
}

function analyzeAndCorrect(data) {
  let issues = [];
  let corrections = [];

  let score = 100;

  // =========================
  // 🏢 ENTREPRISE (CRITIQUE)
  // =========================
  if (isFakeValue(data.entreprise)) {
    issues.push("Entreprise invalide ou fake");

    data.entreprise = null;

    corrections.push("Entreprise supprimée (valeur non fiable)");

    score -= 40; // 🔥 pénalité forte
  } else if (!looksLikeCompany(data.entreprise)) {
    issues.push("Nom entreprise suspect");

    score -= 15;
  }

  // =========================
  // 👷 ENGINEER
  // =========================
  if (data.ingenieurResponsable && isFakeValue(data.ingenieurResponsable)) {
    issues.push("Ingénieur invalide");

    data.ingenieurResponsable = null;

    corrections.push("Ingénieur supprimé (invalide)");

    score -= 20;
  }

  // =========================
  // 📊 STATUS LOGIQUE
  // =========================
  if (data.statut === "Livraison" && data.validationStatut !== "Validé") {
    issues.push("Livraison non validée");

    data.validationStatut = "Validé";

    corrections.push("Validation corrigée automatiquement");

    score -= 15;
  }

  // =========================
  // 🏗 MODELE LOGIQUE
  // =========================
  if (data.projectModele === "revendeur" && !data.comptoir) {
    issues.push("Revendeur sans comptoir");

    score -= 10;
  }

  if (data.projectModele === "applicateur" && !data.dallagiste) {
    issues.push("Applicateur sans dallagiste");

    score -= 10;
  }

  // =========================
  // 📍 GEO
  // =========================
  if (!data.latitude || !data.longitude) {
    issues.push("Localisation manquante");

    score -= 20;
  }

  // =========================
  // 🧠 NORMALISATION SCORE
  // =========================
  if (score < 0) score = 0;

  return {
    data,
    issues,
    corrections,
    isValid: issues.length === 0,
    score,
  };
}

module.exports = { analyzeAndCorrect };