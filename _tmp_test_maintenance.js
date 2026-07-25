require('dotenv').config();
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

// Mock email BEFORE the service is required, so no real network call hits
// the real SMTP credentials / accueilcbif@gmail.com inbox.
const path = require('path');
const emailPath = path.resolve(__dirname, 'src/services/email.service.js');
let emailCalls = [];
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: {
  sendEmail: async (to, subject, text, meta, opts) => {
    emailCalls.push({ to, subject });
    console.log(`  [MOCK EMAIL] to=${to} subject="${subject}"`);
    return { success: true, mocked: true };
  }
}};

require('./src/models/associations');
const { sequelize } = require('./src/db');
const User = require('./src/models/User');
const IndustrialRecord = require('./src/models/IndustrialRecord');
const MaintenanceActivity = require('./src/models/MaintenanceActivity');
const Notification = require('./src/models/Notification');
const { signAccessToken } = require('./src/utils/tokens');

const testApp = express();
testApp.use(express.json());
testApp.use('/industrial-records', require('./src/modules/industrial-records/routes/industrialRecord.routes'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}` + (extra ? ` -- ${JSON.stringify(extra)}` : '')); fail++; }
}

(async () => {
  let otherUser;
  const createdRecordIds = [];
  try {
    // Real authorized account
    const authorizedUser = await User.findOne({ where: { email: 'responsable_logistique@cbi-tunisia.com' } });
    if (!authorizedUser) throw new Error('responsable_logistique@cbi-tunisia.com introuvable en base');
    const authorizedToken = signAccessToken({ sub: authorizedUser.id, email: authorizedUser.email, role: authorizedUser.role });

    // Throwaway user with the SAME role but a DIFFERENT email — proves the
    // check is email-based, not role-based.
    const otherEmail = `test-other-${Date.now()}@example.invalid`;
    const passwordHash = await bcrypt.hash('Test1234!', 4);
    otherUser = await User.create({ id: uuidv4(), email: otherEmail, passwordHash, role: 'responsable_logistique_achat', isActive: true });
    const otherToken = signAccessToken({ sub: otherUser.id, email: otherUser.email, role: otherUser.role });

    const payload = {
      module: 'maintenance',
      machine: 'PROBAR — Machine 2',
      dateFiche: '2026-07-20',
      typePanne: 'Fuite hydraulique',
      urgence: 'critique',
      description: "Fuite d'huile sous la machine",
      statut: 'ouverte',
    };

    // ── Test 1: unauthorized user (same role, different email) -> 403 ──
    console.log('\n[Test 1] Autre utilisateur (même rôle, email différent) -> 403');
    const res1 = await request(testApp).post('/industrial-records').set('Authorization', `Bearer ${otherToken}`).send(payload);
    check('status 403', res1.status === 403, res1.body);
    check('message exact', res1.body.message === "Vous n'êtes pas autorisé à créer une demande de maintenance.");
    check('success:false', res1.body.success === false);

    const countBefore = await IndustrialRecord.count({ where: { module: 'maintenance', machine: payload.machine, typePanne: payload.typePanne } });
    check('aucune fiche créée', countBefore === 0);
    check('aucun email envoyé', emailCalls.length === 0);

    // ── Test 2: authorized user -> 201, side effects ────────────────────
    console.log('\n[Test 2] responsable_logistique@cbi-tunisia.com -> 201 + effets de bord');
    const res2 = await request(testApp).post('/industrial-records').set('Authorization', `Bearer ${authorizedToken}`).send(payload);
    check('status 201', res2.status === 201, res2.body);
    check('success:true', res2.body.success === true);
    check('statut forcé à "En attente"', res2.body.data.statut === 'En attente', res2.body.data);
    const recordId = res2.body.data.id;
    createdRecordIds.push(recordId);

    check('email envoyé à accueilcbif@gmail.com', emailCalls.some(c => c.to === 'accueilcbif@gmail.com'));
    check('sujet exact', emailCalls.some(c => c.subject === 'Nouvelle demande de maintenance'));

    const activity = await MaintenanceActivity.findOne({ where: { industrialRecordId: recordId } });
    check('historique créé', !!activity);
    check('historique: type correct', activity?.type === 'maintenance_request_created');

    const accueil = await User.findOne({ where: { email: 'accueilcbif@gmail.com' } });
    const notif = await Notification.findOne({ where: { userId: accueil.id, type: 'MAINTENANCE_REQUEST_CREATED', message: "Une nouvelle demande de maintenance a été créée par le responsable logistique." } });
    check('notification interne créée pour accueilcbif@gmail.com', !!notif);

    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  } finally {
    for (const id of createdRecordIds) {
      await MaintenanceActivity.destroy({ where: { industrialRecordId: id } });
      const accueil = await User.findOne({ where: { email: 'accueilcbif@gmail.com' } });
      if (accueil) await Notification.destroy({ where: { userId: accueil.id, type: 'MAINTENANCE_REQUEST_CREATED' } });
      await IndustrialRecord.destroy({ where: { id } });
    }
    if (otherUser) await otherUser.destroy();
    console.log('Cleanup done.');
    await sequelize.close();
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(async (e) => {
  console.error('UNEXPECTED ERROR', e);
  await sequelize.close();
  process.exit(1);
});
