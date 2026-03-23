const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({

  destination: (req, file, cb) => {
    cb(null, "uploads/actions/");
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + "-" + Math.random() + ext);
  },

});

const fileFilter = (req, file, cb) => {

  const allowed = [
    "image/jpeg",
    "image/png",
    "application/pdf"
  ];

  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("File not allowed"), false);
  }

};

const upload = multer({
  storage,
  fileFilter,
});

module.exports = upload;