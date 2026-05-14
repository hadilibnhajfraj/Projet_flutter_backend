const Project = require("./Project");
const Company = require("./Company");
const Engineer = require("./Engineer");
const Architect = require("./Architect");
const User = require("./User");
const UserProject = require("./UserProject");

// ✅ simple require (PAS de fonction)
require("./associations");

module.exports = {
  Project,
  Company,
  Engineer,
  Architect,
  User,
  UserProject,
};
