"use strict";

// Seul ce compte peut créer une demande de maintenance (module
// industrial_records, module==='maintenance'). Destinataire fixe des
// notifications de nouvelle demande : l'accueil.
const MAINTENANCE_REQUESTER_EMAIL = "responsable_logistique@cbi-tunisia.com";
const MAINTENANCE_NOTIFY_EMAIL = "accueilcbif@gmail.com";

module.exports = { MAINTENANCE_REQUESTER_EMAIL, MAINTENANCE_NOTIFY_EMAIL };
