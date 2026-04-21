const { DataTypes } = require("sequelize");
const { sequelize } = require("../db");

const CommercialContact = sequelize.define(
  "CommercialContact",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    typeClient: {
      type: DataTypes.ENUM("Tuteur", "Cloture", "Batiment"),
      allowNull: false,
      defaultValue: "autre",
    },

    nomSociete: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },

    nom: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },

    prenom: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },

    localisation: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },

    telephone: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },

    message: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    statut: {
      type: DataTypes.ENUM(
        "ok",
        "rappeler_plus_tard",
        "user_injoignable",
        "client_refuse"
      ),
      allowNull: false,
      defaultValue: "user_injoignable",
    },

    nbAppels: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    sujetDiscussion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    // ✅ NEW
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
      allowNull: false,
      defaultValue: "Prospect",
    },

    // ✅ NEW
   dateAppel: {
  type: DataTypes.DATE,
  allowNull: true, // 🔥 IMPORTANT temporaire
  defaultValue: DataTypes.NOW,
},
user_nom: {
  type: DataTypes.ENUM("najeh", "mooemen", "mayssa"),
  allowNull: true,
},

// 🔥 AJOUT
user_nom_custom: {
  type: DataTypes.STRING,
  allowNull: true,
},
email: {
  type: DataTypes.STRING(150),
  allowNull: true,
  validate: {
    isEmail: true, // ✅ validation automatique
  },
},
matriculeFiscale: {
  type: DataTypes.STRING(50),
  allowNull: true, // ou false si obligatoire
},
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    tableName: "commercial_contacts",
    timestamps: true,
  }
);
module.exports = CommercialContact;