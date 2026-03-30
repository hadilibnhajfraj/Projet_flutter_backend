const Project = require("./Project");
const User = require("./User");
const UserProject = require("./UserProject");

// ✅ simple require (PAS de fonction)
require("./associations");

module.exports = {
  Project,
  User,
  UserProject,
};