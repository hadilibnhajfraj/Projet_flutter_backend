"use strict";

const logisticsManagers = require("./logisticsManagers");

// Seuls les responsables (logistique et production — config/
// logisticsManagers.js) peuvent créer une demande de maintenance (module
// industrial_records, module==='maintenance'). Destinataire fixe des
// notifications de nouvelle demande : l'accueil.
const MAINTENANCE_REQUESTER_EMAIL = "responsable_logistique@cbi-tunisia.com";
const MAINTENANCE_NOTIFY_EMAIL = "accueilcbif@gmail.com";

function isMaintenanceRequester(email) {
  return logisticsManagers.isLogisticsManager(email);
}

module.exports = { MAINTENANCE_REQUESTER_EMAIL, MAINTENANCE_NOTIFY_EMAIL, isMaintenanceRequester };
