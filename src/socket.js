"use strict";

const { Server } = require("socket.io");
const { verifyAccessToken } = require("./utils/tokens");

let _io = null;

// Rôles autorisés dans la salle "admins" (demandes d'archivage).
const ADMIN_ROLES = new Set(["admin", "superadmin", "superadmin2"]);

// Jeton d'accès (même JWT que l'API REST) : `auth.token` (client Flutter),
// sinon en-tête Authorization ou paramètre `token`.
function tokenFrom(handshake) {
  const auth = handshake.auth || {};
  if (auth.token) return String(auth.token).replace(/^Bearer\s+/i, "");
  const header = handshake.headers?.authorization;
  if (header) return String(header).replace(/^Bearer\s+/i, "");
  return handshake.query?.token ? String(handshake.query.token) : null;
}

/**
 * Connexion authentifiée : jeton vérifié à chaque (re)connexion, identité
 * réelle (id, email, rôle) attachée au socket. Sans jeton valide, la
 * connexion est refusée (le client se reconnecte avec un jeton à jour).
 */
function authenticate(socket, next) {
  const token = tokenFrom(socket.handshake);
  if (!token) return next(new Error("UNAUTHORIZED"));
  try {
    const payload = verifyAccessToken(token);
    socket.data.user = { id: payload.sub, email: payload.email, role: payload.role };
    return next();
  } catch (_) {
    return next(new Error("UNAUTHORIZED"));
  }
}

function init(httpServer) {
  _io = new Server(httpServer, {
    cors: {
      origin: [
        "https://www.crmprobar.com",
        "https://crmprobar.com",
        "https://api.crmprobar.com",
        "http://localhost:57745",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  _io.use(authenticate);

  _io.on("connection", (socket) => {
    const user = socket.data.user;
    // Salle personnelle rejointe d'office : chaque utilisateur ne reçoit que
    // ses propres événements, jamais ceux d'un autre.
    socket.join(`user:${user.id}`);
    if (ADMIN_ROLES.has(user.role)) socket.join("admins");

    // Compatibilité : `join` n'accepte que la salle de l'utilisateur connecté
    // (ou "admins" pour un rôle admin) ; toute autre salle est ignorée.
    socket.on("join", (room) => {
      const r = String(room || "");
      if (r === user.id || r === `user:${user.id}`) socket.join(`user:${user.id}`);
      else if (r === "admins" && ADMIN_ROLES.has(user.role)) socket.join("admins");
    });

    socket.on("disconnect", () => {});
  });

  console.log("✅ Socket.IO initialized");
  return _io;
}

function getIo() {
  if (!_io) throw new Error("Socket.IO not initialized — call init() first");
  return _io;
}

// Emit to a specific user room (no-op if socket not yet initialized)
function emitToUser(userId, event, data) {
  if (!_io) return;
  _io.to(`user:${userId}`).emit(event, data);
}

// Emit to all connected clients in a role room
function emitToRoom(room, event, data) {
  if (!_io) return;
  _io.to(room).emit(event, data);
}

// Notification enregistrée en base → son destinataire uniquement, en temps
// réel. Appelé par les hooks du modèle Notification, après validation de la
// transaction : jamais pour une écriture annulée.
function emitNotification(notification) {
  const n = notification?.toJSON ? notification.toJSON() : notification;
  if (!n?.userId) return;
  emitToUser(n.userId, "notification:new", {
    id: n.id,
    type: n.type,
    title: n.title,
    message: n.message,
    isRead: n.isRead === true,
    createdAt: n.createdAt,
    productionFicheType: n.productionFicheType ?? null,
    productionFicheId: n.productionFicheId ?? null,
    rawMaterialRequestId: n.rawMaterialRequestId ?? null,
  });
}

/** Tests : arrêt propre du serveur Socket.IO. */
function close() {
  if (_io) _io.close();
  _io = null;
}

module.exports = { init, getIo, emitToUser, emitToRoom, emitNotification, close };
