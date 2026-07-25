"use strict";

// Résout un nom complet d'affichage à partir d'un User (avec profile
// inclus) — priorité au champ générique "name", puis prenom+nom (champs
// RH), puis repli sur l'email. Aucune donnée codée en dur.
function resolveFullName(user) {
  const profile = user?.profile;

  const name = profile?.name?.trim();
  if (name) return name;

  const prenom = profile?.prenom?.trim();
  const nom = profile?.nom?.trim();
  if (prenom || nom) return [prenom, nom].filter(Boolean).join(" ");

  return user?.email || "";
}

module.exports = { resolveFullName };
