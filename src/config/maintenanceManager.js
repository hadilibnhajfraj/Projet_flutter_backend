"use strict";

// Compte explicitement désigné "Responsable Maintenance" pour la gestion des
// demandes de maintenance (accepter/refuser/affecter/démarrer/terminer),
// en plus des rôles admin/superadmin/superadmin2/responsable_logistique_achat
// (voir requireMaintenanceManager.js). Même pattern que ROOT_ADMIN_EMAIL pour
// les demandes d'archivage.
const MAINTENANCE_MANAGER_EMAIL = "accueilcbif@gmail.com";

module.exports = { MAINTENANCE_MANAGER_EMAIL };
