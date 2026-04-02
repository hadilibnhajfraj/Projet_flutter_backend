// models/Project.js
const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const Project = sequelize.define(
  "Project",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    nomProjet: { type: DataTypes.STRING(200), allowNull: false },

   dateDemarrage: { 
  type: DataTypes.DATEONLY, 
  allowNull: true 
},

    // ✅ NOUVEAU
    dateProspection: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },

    typeAdresseChantier: { type: DataTypes.STRING(255), allowNull: true },

 ingenieurResponsable: { 
  type: DataTypes.STRING(200), 
  allowNull: true 
},

telephoneIngenieur: { 
  type: DataTypes.STRING(30), 
  allowNull: true 
},

    // ✅ NOUVEAU EMAIL INGENIEUR
    emailIngenieur: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    architecte: { type: DataTypes.STRING(200), allowNull: true },
    telephoneArchitecte: { type: DataTypes.STRING(30), allowNull: true },

    // ✅ NOUVEAU EMAIL ARCHITECTE
    emailArchitecte: {
      type: DataTypes.STRING(200),
      allowNull: true,
      validate: { isEmail: true },
    },

    matriculeFiscale: {
      type: DataTypes.STRING(60),
      allowNull: true,
    },
// ✅ nouveaux champs dynamiques
comptoir: {
  type: DataTypes.STRING(200),
  allowNull: true,
},

telephoneComptoir: {
  type: DataTypes.STRING(30),
  allowNull: true,
},

// 🔥 NOUVEAU (revendeur)
telephoneComptoir2: {
  type: DataTypes.STRING(30),
  allowNull: true,
},

dallagiste: {
  type: DataTypes.STRING(200),
  allowNull: true,
},

telephoneDallagiste: {
  type: DataTypes.STRING(30),
  allowNull: true,
},

// 🔥 NOUVEAU (applicateur)
emailDallagiste: {
  type: DataTypes.STRING(200),
  allowNull: true,
  validate: { isEmail: true },
},
// 🔥 TRACKING CRM
dateLimiteIngenieur: {
  type: DataTypes.DATE,
  allowNull: true,
},

isArchived: {
  type: DataTypes.BOOLEAN,
  defaultValue: false,
},

archivedAt: {
  type: DataTypes.DATE,
  allowNull: true,
},
serviceTechnique: {
  type: DataTypes.STRING(200),
  allowNull: true,
},
    entreprise: { type: DataTypes.STRING(200), allowNull: true },

    promoteur: { type: DataTypes.STRING(200), allowNull: true },

    bureauEtude: { type: DataTypes.STRING(200), allowNull: true },

    bureauControle: { type: DataTypes.STRING(200), allowNull: true },

    adresse: { type: DataTypes.STRING(255), allowNull: true },

    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },

    localisationCommentaire: { type: DataTypes.TEXT, allowNull: true },
lastRelanceAt: {
  type: DataTypes.DATE,
  allowNull: true,
},
    statut: {
  type: DataTypes.ENUM(
    "Identification",
    "Proposition technique",
    "Proposition commerciale",
    "Négociation",
    "Livraison",
    "Fidélisation"
  ),
  allowNull: true,
  defaultValue: "Identification",
},

    entrepriseFluide: { type: DataTypes.STRING(200), allowNull: true },

    entrepriseElectricite: { type: DataTypes.STRING(200), allowNull: true },

    pourcentageReussite: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      validate: { min: 0, max: 100 },
    },

    validationStatut: {
      type: DataTypes.ENUM("Validé", "Non validé"),
      allowNull: true,
      defaultValue: "Non validé",
    },

    typeProjet: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
pipelineStage: {
  type: DataTypes.ENUM(
    "Prospect",
    "Contacté",
    "Visite",
    "Devis envoyé",
    "Negociation",
    "Gagné",
    "Perdu"
  ),
  defaultValue: "Prospect",
},
projectModele: {
  type: DataTypes.ENUM("project", "revendeur", "applicateur"),
  allowNull: false,
  defaultValue: "project",
},

// ✅ nouveaux champs dynamiques
comptoir: {
  type: DataTypes.STRING(200),
  allowNull: true,
},
registreCommerce: {
  type: DataTypes.STRING(100),
  allowNull: true,
},

fonction: {
  type: DataTypes.ENUM("achat", "gerant"),
  allowNull: true,
},
telephoneComptoir: {
  type: DataTypes.STRING(30),
  allowNull: true,
},
// 🔥 INFOS PERSONNE REVENDEUR
revendeurNom: {
  type: DataTypes.STRING(100),
  allowNull: true,
},

revendeurPrenom: {
  type: DataTypes.STRING(100),
  allowNull: true,
},

revendeurEmail: {
  type: DataTypes.STRING(200),
  allowNull: true,
  validate: { isEmail: true },
},

// 🔥 STATUT COMMERCIAL REVENDEUR
revendeurStatut: {
  type: DataTypes.ENUM(
    "prospect",
    "offre",
    "actif",
    "rate"
  ),
  allowNull: true,
  defaultValue: "prospect",
},
dallagiste: {
  type: DataTypes.STRING(200),
  allowNull: true,
},

telephoneDallagiste: {
  type: DataTypes.STRING(30),
  allowNull: true,
},
    surfaceProspectee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      validate: { min: 0 },
    },
  },
  {
    tableName: "projects",
    timestamps: true,
  }
);

module.exports = Project;