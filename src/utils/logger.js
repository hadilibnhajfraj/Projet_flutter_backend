"use strict";

// Minimal structured logger — no new dependency. Keeps console noise down
// to error/warn/info only; use logger.info for meaningful timing/lifecycle
// events, not for dumping request bodies or per-field diagnostics.

function timestamp() {
  return new Date().toISOString();
}

function error(message, ...args) {
  console.error(`[${timestamp()}] [ERROR] ${message}`, ...args);
}

function warn(message, ...args) {
  console.warn(`[${timestamp()}] [WARN] ${message}`, ...args);
}

function info(message, ...args) {
  console.log(`[${timestamp()}] [INFO] ${message}`, ...args);
}

module.exports = { error, warn, info };
