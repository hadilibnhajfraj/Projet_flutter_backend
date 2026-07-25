# Configuration Google Calendar (OAuth2)

Ce document explique comment obtenir les identifiants nécessaires pour que le
CRM puisse créer automatiquement des événements dans le Google Calendar des
commerciaux lors d'un Follow-up.

## 1. Créer un projet Google Cloud

1. Aller sur https://console.cloud.google.com/
2. Créer un nouveau projet (ou réutiliser un projet existant).
3. Dans le menu **API et services > Bibliothèque**, rechercher **Google
   Calendar API** et cliquer sur **Activer**.

## 2. Créer les identifiants OAuth2

1. **API et services > Identifiants > Créer des identifiants > ID client
   OAuth**.
2. Type d'application : **Application Web**.
3. **URI de redirection autorisés** — ajouter :
   - `http://localhost:4000/google-calendar/callback` (développement local)
   - `https://api.crmprobar.com/google-calendar/callback` (production)
4. Valider — Google affiche un **ID client** et un **secret client**.

Si l'écran de consentement OAuth n'est pas encore configuré, Google le
demandera d'abord : type **Externe** (ou **Interne** si Google Workspace),
renseigner un nom d'app, et ajouter le scope suivant lors de la
configuration :
- `https://www.googleapis.com/auth/calendar.events`

Tant que l'app est en mode "Test", seuls les comptes Google explicitement
ajoutés comme "utilisateurs de test" pourront se connecter — ajouter les
adresses des commerciaux concernés dans **Écran de consentement OAuth >
Utilisateurs test**, ou publier l'app (vérification Google requise pour un
usage au-delà de 100 utilisateurs).

## 3. Renseigner les variables d'environnement

Dans `Backend Master/.env` :

```
GOOGLE_CLIENT_ID=<Client ID de l'étape 2>
GOOGLE_CLIENT_SECRET=<Client secret de l'étape 2>
GOOGLE_REDIRECT_URI=http://localhost:4000/google-calendar/callback   # ou l'URL de prod
GOOGLE_TOKEN_ENC_KEY=<déjà généré automatiquement — voir ci-dessous>
```

`GOOGLE_TOKEN_ENC_KEY` sert à chiffrer (AES-256-GCM) les refresh tokens
avant stockage en base — une valeur a déjà été générée pour le
développement local. **Pour la production, régénérer une clé dédiée** et ne
jamais la committer :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 4. Appliquer les migrations

```bash
cd "Backend Master"
npm run db:migrate
```

Cela crée la table `google_calendar_accounts` et les colonnes
`googleEventId` / `googleCalendarSynced` / `googleCalendarError` /
`emailError` / `whatsappError` sur `commercial_contact_relances`.

## 5. Utilisation

Chaque commercial connecte son propre compte depuis son écran **Mon
profil** (bouton "Connecter Google Calendar"). Tant qu'un commercial n'a
pas connecté son compte, les Follow-up le concernant continuent de
fonctionner normalement (calendrier interne, notifications, email,
WhatsApp) — seule la synchro Google Calendar est ignorée proprement pour
lui (`googleCalendarSynced=false`, `googleCalendarError=null`).

Depuis l'intégration calendrier des actions Timeline (`ProjectAction`), la
même connexion Google sert aussi à synchroniser automatiquement les
événements créés depuis la Timeline des projets — voir
`Backend Master/docs/calendar-google-sync.md`.

## 6. Synchronisation entrante (Google -> CRM) — canal push

Une modification faite **directement dans Google Calendar** (date, heure,
titre) est répercutée automatiquement sur l'action CRM correspondante, via
un canal push Google (`events.watch`). Ce canal exige une **URL HTTPS
PUBLIQUE** joignable par les serveurs Google — impossible depuis
`localhost` :

```
GOOGLE_CALENDAR_WEBHOOK_BASE_URL=https://api.crmprobar.com
```

- **Non configurée / non https** (par défaut en dev local) : le canal
  n'est simplement pas enregistré (log explicite), tout le reste continue
  de fonctionner normalement (écriture CRM -> Google).
- **Configurée en production** : le canal est enregistré automatiquement à
  chaque connexion Google d'un utilisateur, renouvelé quotidiennement avant
  expiration (`src/cron/googleCalendarChannelRenewal.job.js`, nécessite
  `AUTO_EMAIL_JOBS_ENABLED=true`), et reçoit les notifications sur
  `POST /google-calendar/webhook` (endpoint public, vérifié par un token
  opaque par compte — jamais par le JWT applicatif).
