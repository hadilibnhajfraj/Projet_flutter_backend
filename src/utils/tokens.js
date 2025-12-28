const jwt = require("jsonwebtoken");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function signAccessToken(payload) {
  const secret = mustEnv("JWT_ACCESS_SECRET");
  return jwt.sign(payload, secret, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || "15m",
    issuer: "my-api",
    audience: "my-client",
  });
}

function signRefreshToken(payload) {
  const secret = mustEnv("JWT_REFRESH_SECRET");
  return jwt.sign(payload, secret, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || "7d",
    issuer: "my-api",
    audience: "my-client",
  });
}

function verifyAccessToken(token) {
  const secret = mustEnv("JWT_ACCESS_SECRET");
  return jwt.verify(token, secret, {
    issuer: "my-api",
    audience: "my-client",
  });
}

function verifyRefreshToken(token) {
  const secret = mustEnv("JWT_REFRESH_SECRET");
  return jwt.verify(token, secret, {
    issuer: "my-api",
    audience: "my-client",
  });
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
