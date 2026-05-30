"use strict";

const { Server } = require("socket.io");

let _io = null;

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

  _io.on("connection", (socket) => {
    // Client joins its own user room so we can target it with server→client events
    socket.on("join", (userId) => {
      if (userId) socket.join(`user:${userId}`);
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

module.exports = { init, getIo, emitToUser, emitToRoom };
