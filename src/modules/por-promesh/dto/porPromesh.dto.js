"use strict";

/**
 * Strips internal Sequelize fields and normalises a PorPromesh fiche for API responses.
 */

function toCreatorRef(user) {
  if (!user) return null;
  const u = user.toJSON ? user.toJSON() : user;
  return { id: u.id, email: u.email, role: u.role };
}

function toControleQualite(c) {
  const r = c.toJSON ? c.toJSON() : c;
  return {
    id: r.id,
    heure: r.heure,
    numeroPlaque: r.numeroPlaque,
    maille: r.maille,
    longueur: r.longueur,
    largeur: r.largeur,
    statutCOQ: r.statutCOQ,
  };
}

function toArretMachine(a) {
  const r = a.toJSON ? a.toJSON() : a;
  return {
    id: r.id,
    tArret: r.tArret,
    observationMachine: r.observationMachine,
  };
}

function toConsommation(c) {
  const r = c.toJSON ? c.toJSON() : c;
  return {
    id: r.id,
    designationArticle: r.designationArticle,
    metrage: r.metrage,
    observation: r.observation,
  };
}

function toProcessControl(p) {
  const r = p.toJSON ? p.toJSON() : p;
  return {
    id: r.id,
    bloc: r.bloc,
    parametre: r.parametre,
    valeurP1: r.valeurP1,
    corP1: r.corP1,
    valeurP2: r.valeurP2,
    corP2: r.corP2,
  };
}

function toAttachment(a) {
  const r = a.toJSON ? a.toJSON() : a;
  return { id: r.id, fileName: r.fileName, fileUrl: r.fileUrl, createdAt: r.createdAt };
}

function toNonConformite(n) {
  const r = n.toJSON ? n.toJSON() : n;
  return {
    id: r.id,
    typeNC: r.typeNC,
    gravite: r.gravite,
    description: r.description,
    photoUrl: r.photoUrl,
  };
}

// "PROMESH-2026-000001" — jamais l'UUID affiché à l'utilisateur. L'année
// vient de createdAt (la fiche garde son numéro même consultée une autre
// année) ; à défaut (création en cours, createdAt pas encore connu côté
// client) on retombe sur l'année courante.
function formatNumero(r) {
  if (r.sequenceNumber == null) return null;
  const year = r.createdAt ? new Date(r.createdAt).getFullYear() : new Date().getFullYear();
  return `PROMESH-${year}-${String(r.sequenceNumber).padStart(6, "0")}`;
}

function toPorPromeshResponse(report) {
  if (!report) return null;
  const r = report.toJSON ? report.toJSON() : report;

  return {
    id: r.id,
    sequenceNumber: r.sequenceNumber,
    numero: formatNumero(r),
    status: r.status,
    isLocked: r.isLocked,
    validatedAt: r.validatedAt,

    dateProduction: r.dateProduction,
    heureDebut: r.heureDebut,
    heureFin: r.heureFin,
    operateur: r.operateur,
    machine: r.machine,
    poste: r.poste,

    diametreMaille1: r.diametreMaille1,
    diametreMaille2: r.diametreMaille2,
    diametreMaille3: r.diametreMaille3,

    productionM2: r.productionM2,

    demarrageProductionHeure1: r.demarrageProductionHeure1,
    demarrageProductionQuantite1: r.demarrageProductionQuantite1,
    demarrageProductionHeure2: r.demarrageProductionHeure2,
    demarrageProductionQuantite2: r.demarrageProductionQuantite2,

    responsable1: r.responsable1,
    responsable2: r.responsable2,
    operateur1: r.operateur1,
    operateur2: r.operateur2,
    aideOperateur: r.aideOperateur,
    manoeuvre: r.manoeuvre,
    stagiaire1: r.stagiaire1,
    stagiaire2: r.stagiaire2,
    // Vue imbriquée attendue par le front Flutter (en plus des champs plats
    // ci-dessus, conservés pour compatibilité).
    personnelActif: {
      responsable1: r.responsable1,
      responsable2: r.responsable2,
      operateur1: r.operateur1,
      operateur2: r.operateur2,
      aideOperateur: r.aideOperateur,
      manoeuvre: r.manoeuvre,
      stagiaire1: r.stagiaire1,
      stagiaire2: r.stagiaire2,
    },
    observationPersonnel: r.observationPersonnel,

    heureFinTravail: r.heureFinTravail,
    observationFinTravail: r.observationFinTravail,

    totalMainOeuvre: r.totalMainOeuvre,
    totalChuteBarres: r.totalChuteBarres,
    totalDechetGraine: r.totalDechetGraine,

    visaProduction: r.visaProduction,
    visaControleQualite: r.visaControleQualite,
    visaDirection: r.visaDirection,

    air: r.air,
    niveauBainEau: r.niveauBainEau,
    temperatureEau: r.temperatureEau,
    temperaturePistons: r.temperaturePistons,
    etatPistons: r.etatPistons,
    fluideVisuel: r.fluideVisuel,
    etatDisqueCoupe: r.etatDisqueCoupe,

    observationsGenerales: r.observationsGenerales,
    justificationControleProcess: r.justificationControleProcess,
    justificationControleMachine: r.justificationControleMachine,
    visaResponsableLogistiqueProcess: r.visaResponsableLogistiqueProcess,
    visaControleQualiteProcess: r.visaControleQualiteProcess,
    visaProductionProcess: r.visaProductionProcess,
    dateValidationProcess: r.dateValidationProcess,

    conformite: r.conformite,
    descriptionNonConformite: r.descriptionNonConformite,
    photoNonConformite: r.photoNonConformite,
    actionsCorrectives: r.actionsCorrectives,

    createdBy: r.createdBy,
    creator: toCreatorRef(r.creator),

    controlesQualite: (r.controlesQualite || []).map(toControleQualite),
    arretsMachine: (r.arretsMachine || []).map(toArretMachine),
    consommations: (r.consommations || []).map(toConsommation),
    processControl: (r.processControl || []).map(toProcessControl),
    nonConformites: (r.nonConformites || []).map(toNonConformite),
    attachments: (r.attachments || []).map(toAttachment),

    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toPorPromeshList(reports) {
  return reports.map(toPorPromeshResponse);
}

module.exports = { toPorPromeshResponse, toPorPromeshList };
