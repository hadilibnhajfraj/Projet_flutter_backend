const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const PorPromesh = sequelize.define(
  "PorPromesh",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // Numéro de fiche lisible — posé par une séquence Postgres dédiée
    // (créée par la migration, nextval() est atomique : deux créations
    // simultanées ne peuvent jamais recevoir le même numéro, sans verrou ni
    // transaction applicative à gérer). Jamais l'UUID affiché à
    // l'utilisateur. Le DTO calcule "PROMESH-{année}-{sequenceNumber sur 6
    // chiffres}" à partir de ce champ.
    //
    // `defaultValue: sequelize.literal(...)` est indispensable ici : sans
    // lui, la validation `allowNull: false` de Sequelize s'exécute côté JS
    // *avant* l'INSERT et rejette l'objet (`notNull Violation`) parce qu'il
    // ignore le DEFAULT posé directement en base par la migration — il faut
    // le déclarer aussi côté modèle pour que Sequelize sache qu'une valeur
    // sera fournie par la base.
    sequenceNumber: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      defaultValue: sequelize.literal('nextval(\'"por_promesh_sequenceNumber_seq"\')'),
    },

    // Saisis par l'opérateur à l'étape "Informations générales" — la fiche
    // brouillon peut exister sans ces 3 champs ; ils ne sont exigés qu'au
    // verrouillage définitif (POST /:id/validate).
    dateProduction: { type: DataTypes.DATEONLY, allowNull: true },
    heureDebut: { type: DataTypes.TIME, allowNull: true },
    heureFin: { type: DataTypes.TIME, allowNull: true },
    // Opérateur connecté ayant saisi la fiche — sélectionné manuellement,
    // jamais déduit automatiquement de la session.
    operateur: { type: DataTypes.STRING(255), allowNull: true },

    // Identifie la machine PROMESH (1..4) et le poste (matin/nuit) à
    // l'origine de la fiche — préremplis depuis la page Machine du nouveau
    // module industriel, nullable pour ne pas casser les fiches existantes.
    machine: { type: DataTypes.STRING(10), allowNull: true },
    poste: { type: DataTypes.ENUM("matin", "nuit"), allowNull: true },

    diametreMaille1: { type: DataTypes.STRING(50), allowNull: true },
    diametreMaille2: { type: DataTypes.STRING(50), allowNull: true },
    diametreMaille3: { type: DataTypes.STRING(50), allowNull: true },

    // ── Module Rendement (parcours opérateur simplifié) — une seule mesure,
    // toujours exprimée en m², jamais en kg.
    productionM2: { type: DataTypes.DECIMAL(10, 2), allowNull: true },

    demarrageProductionHeure1: { type: DataTypes.TIME, allowNull: true },
    demarrageProductionQuantite1: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    demarrageProductionHeure2: { type: DataTypes.TIME, allowNull: true },
    demarrageProductionQuantite2: { type: DataTypes.DECIMAL(10, 2), allowNull: true },

    responsable1: { type: DataTypes.STRING(255), allowNull: true },
    responsable2: { type: DataTypes.STRING(255), allowNull: true },

    operateur1: { type: DataTypes.STRING(255), allowNull: true },
    operateur2: { type: DataTypes.STRING(255), allowNull: true },

    aideOperateur: { type: DataTypes.STRING(255), allowNull: true },
    manoeuvre: { type: DataTypes.STRING(255), allowNull: true },

    stagiaire1: { type: DataTypes.STRING(255), allowNull: true },
    stagiaire2: { type: DataTypes.STRING(255), allowNull: true },

    observationPersonnel: { type: DataTypes.TEXT, allowNull: true },

    heureFinTravail: { type: DataTypes.TIME, allowNull: true },
    observationFinTravail: { type: DataTypes.TEXT, allowNull: true },

    totalMainOeuvre: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    totalChuteBarres: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    totalDechetGraine: { type: DataTypes.DECIMAL(10, 2), allowNull: true },

    visaProduction: { type: DataTypes.STRING(255), allowNull: true },
    visaControleQualite: { type: DataTypes.STRING(255), allowNull: true },
    visaDirection: { type: DataTypes.STRING(255), allowNull: true },

    // ── Étape 2 — Plan de Process PROMESH ───────────────────
    // `bainResine`, `etatAtelier` et `zoneStockage` ont été supprimés
    // (module "Contrôle Machine" — champs retirés du périmètre). Colonnes
    // droppées par la migration correspondante ; toute fiche existante ne
    // les référence plus.
    air: { type: DataTypes.STRING(50), allowNull: true },
    niveauBainEau: { type: DataTypes.STRING(50), allowNull: true },
    temperatureEau: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    // Anciennement `temperatureDemandee` (renommé) — saisie numérique
    // libre, plus de préréglages 160/170/180.
    temperaturePistons: { type: DataTypes.DOUBLE, allowNull: true },
    etatPistons: { type: DataTypes.STRING(50), allowNull: true },
    fluideVisuel: { type: DataTypes.STRING(50), allowNull: true },
    etatDisqueCoupe: { type: DataTypes.STRING(50), allowNull: true },
    // `note` (note /10) et `signatureChefEquipe` ont été supprimés — écran
    // "Contrôle Qualité" simplifié (ne conserve que le tableau de mesures +
    // l'observation responsable production, partagée avec le module
    // Observation).

    // ── Étape 5 — Contrôle Process PROMESH ──────────────────
    observationsGenerales: { type: DataTypes.TEXT, allowNull: true },
    // Justification partagée des contrôles en anomalie — une par section,
    // jamais confondue avec `observationsGenerales` (commentaire libre du
    // module Observation, sans rapport).
    justificationControleProcess: { type: DataTypes.TEXT, allowNull: true },
    justificationControleMachine: { type: DataTypes.TEXT, allowNull: true },
    visaResponsableLogistiqueProcess: { type: DataTypes.STRING(255), allowNull: true },
    visaControleQualiteProcess: { type: DataTypes.STRING(255), allowNull: true },
    visaProductionProcess: { type: DataTypes.STRING(255), allowNull: true },
    dateValidationProcess: { type: DataTypes.DATEONLY, allowNull: true },

    // ── Module N/C (parcours opérateur simplifié) — une seule conformité par
    // fiche. Les 3 derniers champs ne sont renseignés que si non_conforme.
    conformite: { type: DataTypes.ENUM("conforme", "non_conforme"), allowNull: true },
    descriptionNonConformite: { type: DataTypes.TEXT, allowNull: true },
    photoNonConformite: { type: DataTypes.STRING(500), allowNull: true },
    actionsCorrectives: { type: DataTypes.TEXT, allowNull: true },

    // Cycle de vie : BROUILLON (modifiable/supprimable) → VALIDE (figée).
    // Le statut n'est jamais piloté par le client sur create/update — seul
    // POST /por-promesh/:id/validate fait passer une fiche à VALIDE.
    status: {
      type: DataTypes.ENUM("BROUILLON", "VALIDE"),
      allowNull: false,
      defaultValue: "BROUILLON",
    },

    // Verrou définitif posé uniquement par /por-promesh/:id/validate —
    // cf. service.update/delete/validate. Reste `false` tant que la fiche
    // est en BROUILLON.
    isLocked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Horodatage de la validation définitive (NULL tant que non validée).
    validatedAt: { type: DataTypes.DATE, allowNull: true },

    createdBy: { type: DataTypes.UUID, allowNull: false },
  },
  {
    tableName: "por_promesh",
    timestamps: true,
    indexes: [
      { fields: ["dateProduction"] },
      { fields: ["createdBy"] },
      { fields: ["createdAt"] },
    ],
  }
);

module.exports = PorPromesh;
