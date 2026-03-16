const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({

  host: "smtp.gmail.com",
  port: 587,
  secure: false,

  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }

});

async function sendRelanceEmail(userEmail, projectName) {

  await transporter.sendMail({

    from: `"CRM PROBAR" <${process.env.EMAIL_USER}>`,

    to: userEmail,

    subject: "Relance commerciale automatique",

    html: `
      <h3>Relance commerciale</h3>

      <p>Le projet <b>${projectName}</b> nécessite une relance.</p>

      <p>Aucune action commerciale n'a été enregistrée depuis plus de 48h.</p>

      <p>Merci de contacter ce prospect.</p>

      <br>

      <b>CRM PROBAR</b>
    `

  });

}

module.exports = { sendRelanceEmail };