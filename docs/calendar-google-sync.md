# Intégration Calendrier CRM + Google Calendar — actions Timeline

Chaque action créée dans la Timeline d'un projet (`ProjectAction`) crée/met
à jour/supprime automatiquement :
1. Un événement dans le calendrier CRM personnel de l'agent responsable
   (l'écran Calendar existant, table `tasks`).
2. Un événement dans le Google Calendar de cet agent, s'il a connecté son
   compte (voir `GOOGLE_CALENDAR_SETUP.md`).

L'agent ciblé est **`Project.ownerId`** (le responsable du projet), pas
`ProjectAction.createdBy` — un manager peut créer une action pour un projet
dont il n'est pas responsable, l'événement doit tout de même apparaître chez
le bon agent.

Cette intégration **généralise un pattern déjà en production** pour les
relances commerciales (`CommercialContactRelance` /
`followupAutomation.service.js`) — voir ce fichier pour le précédent exact.

## Modèle de données

| Table | Nouvelles colonnes |
|---|---|
| `project_actions` | `priorite` (ENUM basse/normale/haute/urgente, défaut normale), `dateFin`, `calendarEventId` (→ `tasks.id`), `googleEventId`, `googleCalendarSynced`, `googleCalendarError`, `googleUpdatedAt` (cache anti-boucle), `lastReminderSent` |
| `tasks` | `endAt` (fin réelle — avant cette colonne, le Flutter affichait toujours startAt+30min en dur), `priority` |
| `google_calendar_accounts` | `watchChannelId`, `watchResourceId`, `watchExpiration`, `watchToken`, `nextSyncToken` (canal push Google, sync entrante) |
| `notifications` | `actionId` (relation flexible supplémentaire, même pattern que `relanceId`/`hrRequestId`) |

Migrations : `20260727000200` à `20260727000500` dans `src/migrations/`.

## Services backend (nouveaux)

- **`src/services/projectActionCalendar.service.js`** — construit le
  titre/description de l'événement et gère le `Task` (calendrier CRM) de
  façon idempotente via `action.calendarEventId`. `Task.createdBy =
  project.ownerId` (pas l'auteur de l'action).
- **`src/services/projectActionGoogleSync.service.js`** — create/update/
  delete de l'événement Google via `googleCalendar.service.js` (inchangé),
  ciblant `project.ownerId`. Ajoute des rappels natifs Google (24h/1h/15min,
  point 6 "Notification Google") via le nouveau paramètre `reminderMinutes`
  de `buildEventPayload()`.
- **`src/services/projectActionCalendarSync.service.js`** — orchestrateur :
  `onActionCreated`/`onActionUpdated`/`onActionDeleted`/
  `onProjectOwnerChanged`. Transaction critique (Task + Notification +
  historique) puis best-effort après commit (Google + Socket.IO) — même
  contrat que `runFollowupAutomation`.
- **`src/services/googleCalendarWatch.service.js`** (Phase B) —
  enregistrement/arrêt/renouvellement du canal push Google
  (`events.watch`). Best-effort et conditionnel : sans
  `GOOGLE_CALENDAR_WEBHOOK_BASE_URL` en https, le canal n'est simplement pas
  enregistré (log explicite), le reste du système continue de fonctionner.
- **`src/services/googleCalendarInboundSync.service.js`** (Phase B) — sync
  entrante Google → CRM (sync incrémentale par `syncToken`), avec un garde
  anti-boucle (`googleUpdatedAt`) et une décision de sécurité : un événement
  supprimé dans Google **désynchronise** l'action CRM (efface
  `googleEventId`, notifie l'agent) mais **ne la supprime jamais**.

## Points d'accroche

- `src/modules/project-actions/services/projectAction.service.js` —
  `createAction`/`updateAction`/`deleteAction` appellent l'orchestrateur
  après leur transaction Sequelize, en best-effort (jamais bloquant).
- `src/modules/projects/services/project.service.js::assignOwner` — après
  réassignation du responsable d'un projet, migre tous les événements
  calendrier/Google des actions déjà synchronisées (supprime chez l'ancien
  propriétaire, recrée chez le nouveau).
- `src/routes/googleCalendar.routes.js` — nouvelle route publique
  `POST /webhook` (sans `authRequired`, même contrat que `/callback`) ;
  `registerWatchChannel`/`stopWatchChannel` branchés sur `/callback` et
  `/disconnect`.
- `src/cron/followup.job.js` — nouvelle fonction `checkActionReminders()`
  (même moteur de seuils 24h/1h/15min que `checkReminders()`), appelée dans
  `runFollowupChecks()`.
- `src/cron/googleCalendarChannelRenewal.job.js` (nouveau) — renouvelle
  quotidiennement les canaux push proches de l'expiration.

## Historique

Pas de nouvelle table — réutilisation de `ProjectActivity` (déjà utilisée
pour `action_created`/`action_updated`), nouveaux `type` :
`calendar_event_created`, `calendar_event_updated`, `calendar_event_deleted`,
`google_calendar_synced`, `google_calendar_updated_from_google`,
`google_calendar_error`. Consultable via l'endpoint déjà existant
`GET /projects/:projectId/activities`.

## Frontend (Flutter)

- `lib/forms/view/add_project_action_screen.dart` — sélecteur d'heure (en
  plus de la date), sélecteur de durée (15/30/60/120 min → `dateFin`),
  dropdown Priorité.
- `lib/services/project_action_api.dart` — `dateFin`/`priorite` envoyés à
  la création.
- `lib/forms/controller/project_timeline_controller.dart` (`ProjectActionModel`,
  le modèle réellement utilisé par l'écran Timeline) — nouveaux champs
  `calendarEventId`/`googleCalendarSynced`/`googleCalendarError`.
- `lib/forms/view/project_timeline_screen.dart` — badge `_CalendarSyncBadge`
  par action ("📅 Synchronisé" + indicateur Google Calendar coloré selon
  l'état, tooltip reprenant le message "Google Calendar non connecté..." si
  applicable).
- `lib/application/calendar/model/task_model.dart` +
  `calendar_controller_x.dart` — lisent `endAt`/`priority` (fallback +30min
  inchangé si absent, coloration par priorité).

## Tests

`src/scripts/test-calendar-google-sync.js` — même convention que
`test-product-family-diameter.js` (pas de Jest/Mocha dans ce repo) : pilote
l'API HTTP réelle d'un serveur de dev déjà lancé avec un JWT signé, crée son
propre projet/action de test et nettoie après coup.

```
node src/scripts/test-calendar-google-sync.js
```

Couvre : création d'action → Task créé chez le bon propriétaire (pas
l'auteur), `googleCalendarSynced=false`/`googleCalendarError=null` (skip
propre, compte non connecté), historique loggé ; modification de date/heure
→ même Task (pas de doublon) ; **réassignation du propriétaire du projet**
→ `Task.createdBy` suit le nouveau responsable ; suppression → Task
supprimé, aucun orphelin.

**Dernière exécution : 24/24 assertions passées.**

Webhook (Phase B) vérifié par un appel simulé direct sur
`POST /google-calendar/webhook` (channel inconnu → répond 200, log un
avertissement, ne plante pas) — un aller-retour Google réel nécessite un
déploiement HTTPS public (voir `GOOGLE_CALENDAR_SETUP.md` §6), non
disponible pendant cette session (`.env` local pointe sur `localhost`).

## Correctifs — session du 2026-07-21 (retour utilisateur : "Synchronisé" affiché à tort, emails absents)

Avant de corriger quoi que ce soit, chaque symptôme signalé a été vérifié
directement (pas seulement en base CRM, mais avec de vrais appels à l'API
Google Calendar) :

- **Le push CRM → Google fonctionnait déjà réellement** : une action créée
  via l'app avait un vrai événement Google Calendar confirmé (`HTTP 200`,
  `status: "confirmed"`, lien Google réel). Ce n'était donc pas un mensonge
  du badge sur le fond — mais sur la forme, oui (voir ci-dessous).
- Les 174 relances commerciales existantes (`CommercialContactRelance`)
  avaient elles aussi de vrais `googleEventId` récents — cette fonctionnalité
  séparée, non modifiée dans cette session, fonctionne bien.
- **Vrai bug trouvé** : `project_actions.typeAction_legacy` — bien que le
  modèle Sequelize la déclare `STRING(100)` (texte libre) — était en réalité
  un **ENUM Postgres** limité à 9 valeurs historiques (reliquat d'un ancien
  renommage de colonne). Toute action de type **"Appel", "Réunion",
  "Maintenance"**, "Suivi", "Démonstration" ou "Installation" — pourtant
  tous des types demandés — échouait en **HTTP 500** et n'était donc
  **jamais créée**, jamais synchronisée, jamais notifiée. C'est la cause la
  plus probable de "les actions/relances ne sont pas créées".
  → Corrigé par la migration `20260728000200-fix-project-actions-type-action-legacy-enum.js`
  (colonne convertie en `VARCHAR(100)`) + les nouveaux types ajoutés au
  formulaire Flutter (`add_project_action_screen.dart`) et à
  `kActionIcon`/`kActionColor` (`pipeline_theme.dart`).
- **Vrai bug trouvé (UI)** : le badge Timeline affichait toujours le mot
  "Synchronisé" (état du calendrier CRM interne) juste à côté d'un second
  indicateur "Google Calendar" recoloré selon l'état réel — lu ensemble,
  ça se lit comme "Synchronisé [avec] Google Calendar" même quand Google
  n'avait pas confirmé l'événement. Corrigé : `_CalendarSyncBadge` affiche
  maintenant strictement soit **"✓ Synchronisé"** (uniquement si
  `googleCalendarSynced === true`, jamais mis à `true` côté backend sans un
  succès HTTP confirmé), soit **"⚠ Non synchronisé"** + un bouton
  **"Réessayer la synchronisation"**.
- **Vrai gap trouvé** : aucun email n'était envoyé à la création d'une
  action (seulement une notification CRM in-app + les rappels natifs
  Google). Ajouté : `sendActionEmail()` dans
  `projectActionCalendarSync.service.js` (sujet "Nouvelle action CRM",
  Projet/Client/Titre/Date/Heure/Description/Lien CRM).
- **Cause racine des emails de rappel absents** : `AUTO_EMAIL_JOBS_ENABLED`
  était à `false` — un interrupteur de sécurité déjà présent dans le code
  (pas un bug introduit), qui coupe TOUS les crons d'email automatique
  (`followup.job.js`, `checkProjects.js`, `projectCron.js`,
  `reminderService.js`). **Activé sur confirmation explicite de
  l'utilisateur** — réactive donc aussi ces autres crons préexistants, pas
  seulement les rappels d'actions Timeline.

### Nouveaux champs stockés (point 7)
`googleEventLink` (lien direct "Ouvrir dans Google Calendar", `event.htmlLink`)
et `googleCalendarId` (calendrier ciblé, `"primary"` aujourd'hui) — migration
`20260728000100`. `conferenceLink` non implémenté (aucune création de
visioconférence n'est demandée à Google aujourd'hui — nécessiterait un
paramètre `conferenceDataVersion=1` supplémentaire, hors périmètre de cette
correction, à construire si besoin).

### Nouvel endpoint
`POST /projects/:projectId/actions/:id/retry-google-sync` — relance
uniquement la synchro Google (le Task/calendrier CRM existe déjà), retourne
l'action à jour pour rafraîchir le badge immédiatement.

### Logs ajoutés (point 10)
`[CRM Action Created]`, `[Google API Response]` (avec HTTP status),
`[Google Event ID]`, `[Google Event Created/Updated/Deleted]`,
`[Email Sent]` — dans `googleCalendar.service.js`,
`projectActionGoogleSync.service.js`, `projectActionCalendarSync.service.js`.

## Synchronisation multi-destinataires — session du 2026-07-21 (soir)

Le CRM ne crée toujours qu'**une seule** action/relance, mais Google Calendar
reçoit désormais le même événement dans **plusieurs** calendriers,
systématiquement :
1. `info@probardistribution.com` (toujours).
2. Le commercial concerné (`Project.ownerId` pour une action,
   `relance.commercialId` pour un follow-up) — **dédupliqué** si son email
   est identique à celui d'info (un seul événement, jamais de doublon).

### Nouveau modèle : `CalendarEventSync` (remplace "un seul `googleEventId`")

Table `calendar_event_syncs` — une ligne par **destinataire** (pas par
action) : `entityType` ('project_action'|'commercial_contact_relance'),
`entityId`, `userId`, `googleEventId`, `googleEventLink`, `calendarId`,
`synced`, `error`, `googleUpdatedAt`. Contrainte unique
`(entityType, entityId, userId)` — upsert idempotent. C'est la structure
`calendarSyncs` demandée :
```
[{ userId: infoUserId,  googleEventId: "...", calendar: "primary" },
 { userId: hadilUserId, googleEventId: "...", calendar: "primary" }]
```
Les anciens champs agrégés (`ProjectAction.googleEventId`/`googleCalendarSynced`/
`googleCalendarError`, et l'équivalent sur `CommercialContactRelance`) sont
conservés en lecture pour ne rien casser côté Flutter (badge Timeline) —
ils reflètent maintenant "tous les destinataires synchronisés ?", la vérité
détaillée par destinataire vivant dans `calendar_event_syncs`.

### Service partagé : `src/services/multiRecipientCalendarSync.service.js`

Utilisé par les DEUX pipelines (actions Timeline ET relances commerciales,
qui avaient chacun leur propre logique dupliquée) :
- `resolveRecipients({ selectedUserId })` — résout info@... + le commercial
  sélectionné, dédupliqués par email.
- `syncEventForRecipients(...)` — upsert d'une ligne `CalendarEventSync` +
  create/update Google **par destinataire** (best-effort, un échec
  n'affecte pas les autres).
- `removeRecipient(...)` — retire UN destinataire précis (réassignation de
  responsable : l'ancien quitte la liste, info@... n'est jamais affecté).
- `deleteEventForRecipients(...)` — supprime tous les événements + toutes
  les lignes d'une entité.
- `sendEmailToRecipients(...)` — même liste dédupliquée pour les emails
  (point "Emails suivent exactement la même logique").

### Fichiers modifiés
- **Nouveau** `src/models/CalendarEventSync.js` + migration
  `20260728000300-create-calendar-event-syncs.js`.
- **Nouveau** `src/services/multiRecipientCalendarSync.service.js`.
- `src/services/projectActionGoogleSync.service.js` — délègue au service
  partagé (`entityType:"project_action"`), ajoute `removeOwnerRecipient()`.
- `src/services/followupAutomation.service.js` — `syncGoogleCalendarEvent`/
  `syncStatusOnlyChange`/étape email délèguent au même service partagé
  (`entityType:"commercial_contact_relance"`).
- `src/services/projectActionCalendarSync.service.js` — email désormais
  envoyé à tous les destinataires (plus seulement au propriétaire).
- `src/services/googleCalendarInboundSync.service.js` (Phase B) — la sync
  entrante retrouve l'action via `CalendarEventSync` (googleEventId +
  userId), plus via l'ancien champ agrégé (qui ne représente qu'un seul
  destinataire parmi plusieurs).

### Logs (format demandé)
```
Projet     : <nom>
Commercial : <nom du commercial>
Calendrier : info@probardistribution.com
Event ID   : <id Google>
Calendrier : hadil.ibnhajfraj@gmail.com
Event ID   : <id Google>
Emails envoyés : info@probardistribution.com, hadil.ibnhajfraj@gmail.com
```

### Tests réalisés — `test-multi-recipient-calendar-sync.js` (nouveau, 20/20)
- **Commercial = Hadil** (Google connecté, différent d'info) : 2 lignes
  `CalendarEventSync` créées (info skip proprement car non connecté, Hadil
  synchronisé) → événement Hadil vérifié en direct sur l'API Google (HTTP
  200, `status:confirmed`) → modification de date → même `googleEventId`
  (pas de doublon) → suppression → 0 ligne restante (aucun orphelin).
- **Commercial = info@probardistribution.com** : exactement **1** ligne
  `CalendarEventSync` (déduplication confirmée, pas de doublon).
- **Commercial = Faycel** (non connecté) : 2 lignes créées, aucune erreur
  dure (skip propre pour les deux si non connectés).

## Fix — calendrier CRM des follow-ups incomplet (session du 2026-07-21, tard)

**Cause exacte** : `followupAutomation.service.js` créait bien des
Notifications pour les deux destinataires (info@ + commercial), mais le
**calendrier CRM** (`createFollowupTask()` dans `calendar.service.js`) ne
créait qu'**une seule** ligne `tasks`, avec `createdBy: actorUserId` — et
`actorUser` est TOUJOURS info@probardistribution.com (seul compte autorisé
à déclencher l'automatisation, voir `_isFollowupAutomationActor()` dans
`commercial_contacts.routes.js`). Résultat : `GET /tasks` (qui filtre par
`Task.createdBy = req.user.sub`) ne renvoyait jamais cette Task au
commercial affecté — seul le créateur (toujours info@) voyait le follow-up
dans son Calendrier Follow-up.

**Fix** : nouvelle fonction partagée `syncTaskForRecipients()` dans
`multiRecipientCalendarSync.service.js` — crée/met à jour **une Task par
destinataire** (`Task.createdBy = destinataire`), suivie via le nouveau
champ `CalendarEventSync.taskId` (migration `20260728000400`). Aucun
changement nécessaire côté `GET /tasks` : le filtre `createdBy` existant
fonctionne déjà correctement dès que chaque destinataire a sa propre ligne.

`followupAutomation.service.js` réécrit pour que Notification/Task
CRM/Google Calendar/Email utilisent tous la MÊME liste de destinataires
(`resolveRecipients({ selectedUserId: relance.commercialId })`) — "le
traitement est identique pour tous les utilisateurs". `syncStatusOnlyChange`
corrigé de la même façon (met à jour le Task de CHAQUE destinataire, pas
seulement l'ancien champ agrégé `relance.calendarEventId`).

### Fichiers modifiés
- **Nouveau** : migration `20260728000400-add-task-id-to-calendar-event-syncs.js`.
- `src/models/CalendarEventSync.js` — colonne `taskId`.
- `src/services/multiRecipientCalendarSync.service.js` — `syncTaskForRecipients()`
  (nouveau), `removeRecipient()`/`deleteEventForRecipients()` suppriment
  aussi le Task de chaque destinataire.
- `src/services/followupAutomation.service.js` — Notification/Task CRM
  utilisent maintenant la même liste `recipients` ; logs groupés par
  destinataire (`Destinataire :` / `Notification créée` / `Calendrier CRM
  créé` / `Google Calendar synchronisé` / `Email envoyé`).

### Tests réalisés — `test-followup-multi-recipient.js` (nouveau) : **13/13**
Création d'une relance réelle (contact existant, commercial = Hadil,
compte Google connecté) via `POST /commercial-contacts/:id/relances` :
Notification créée pour les DEUX destinataires ✓, Task créé pour les DEUX
avec `createdBy` correct (donc visible dans le bon Calendrier Follow-up de
chacun) ✓, Google Calendar synchronisé pour Hadil / skip propre pour
info@ (non connecté) ✓. Nettoyage automatique des données de test.

### Tests réalisés (avec un vrai compte Google connecté)
Script `test-calendar-google-sync.js` : 24/24 (compte non connecté, chemin
"skip propre"). Vérification manuelle supplémentaire avec le compte Google
réellement connecté de cette session : création d'une action "Réunion"
(type auparavant bloquant) → `HTTP 201` → événement Google confirmé en
direct (`GET .../events/:id` → `200`, `status: confirmed`, rappels
`1440/60/15 min`) → bouton retry → `HTTP 200` → email tenté (échec dû à un
rate-limit SMTP Hostinger provoqué par le volume de tests de cette session,
pas un bug — le comportement best-effort a été confirmé correct : l'échec
email n'a pas empêché la création de l'action ni la synchro Google).
