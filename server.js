/**
 * Telementary — minimal telemetry API for Minecraft activity data.
 *
 * Receives JSON telemetry over HTTPS (e.g. from the Fern Minecraft mod),
 * authenticates it with a shared secret token, and stores it in a local
 * JSON file. One service, no database — ready to deploy on Railway.
 *
 * Endpoints:
 *   GET  /                -> service info
 *   GET  /api/health      -> health check (no auth)
 *   POST /api/telemetry   -> store telemetry   (auth required)
 *   GET  /api/telemetry   -> read telemetry    (auth required)
 *
 * Environment:
 *   TELEMETRY_TOKEN  shared secret required on telemetry endpoints
 *   PORT             HTTP port (Railway sets this automatically)
 *   DATA_DIR         folder for telemetry.json (default: ./data)
 *   MAX_RECORDS      keep only the newest N records (default: 5000)
 */

"use strict";

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const AUTH_TOKEN = process.env.TELEMETRY_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "telemetry.json");
const MAX_RECORDS = Number(process.env.MAX_RECORDS) || 5000;

/* --------------------------------------------------------------- storage */

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, "[]\n", "utf8");
}

function loadRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[telementary] could not read data file:", error.message);
    return [];
  }
}

function saveRecords(records) {
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(records, null, 2), "utf8");
  fs.renameSync(tmpFile, DATA_FILE); // atomic replace on the same filesystem
}

/* ------------------------------------------------------------------ auth */

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function extractToken(req) {
  const authorization = req.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  return bearer || req.get("x-telemetry-token") || req.get("x-api-key") || "";
}

function isAuthorized(req) {
  if (!AUTH_TOKEN) return false; // fail closed when no token is configured
  const token = extractToken(req);
  return token.length > 0 && safeEqual(token, AUTH_TOKEN);
}

/* ------------------------------------------------------------------- app */

const app = express();
app.set("trust proxy", 1); // Railway runs behind a proxy
app.use(express.json({ limit: "256kb" }));

app.get("/", (req, res) => {
  res.json({
    service: "telementary",
    description: "Telemetry receiver for Minecraft activity data (e.g. the Fern mod).",
    endpoints: {
      health: "GET /api/health",
      store: "POST /api/telemetry",
      read: "GET /api/telemetry?limit=100",
    },
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.1.0",
    uptimeSeconds: Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

app.post("/api/telemetry", (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  if (!req.is("application/json")) {
    return res
      .status(415)
      .json({ ok: false, error: "Content-Type must be application/json" });
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    return res
      .status(400)
      .json({ ok: false, error: "body must be a JSON object or array" });
  }

  const incoming = Array.isArray(body) ? body : [body];
  if (incoming.length === 0) {
    return res.status(400).json({ ok: false, error: "payload is empty" });
  }
  if (incoming.length > 500) {
    return res
      .status(413)
      .json({ ok: false, error: "too many records in one request (max 500)" });
  }

  const receivedAt = new Date().toISOString();
  const remoteAddress = req.ip;
  const records = loadRecords();
  for (const payload of incoming) {
    records.push({ receivedAt, remoteAddress, payload });
  }
  const trimmed =
    records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records;
  saveRecords(trimmed);

  console.log(
    `[telementary] stored ${incoming.length} record(s) from ${remoteAddress}`
  );
  res
    .status(202)
    .json({ ok: true, received: incoming.length, stored: trimmed.length });
});

app.get("/api/telemetry", (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const records = loadRecords();
  // offset counts back from the newest record, so offset=0 returns the latest `limit` records
  const end = Math.max(records.length - offset, 0);
  const start = Math.max(end - limit, 0);
  res.json({
    ok: true,
    total: records.length,
    offset,
    returned: end - start,
    records: records.slice(start, end),
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not found" });
});

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  if (error && error.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "invalid JSON body" });
  }
  console.error("[telementary] unexpected error:", error);
  res.status(500).json({ ok: false, error: "internal server error" });
});

app.listen(PORT, () => {
  console.log(`[telementary] listening on port ${PORT}`);
  console.log(`[telementary] data file: ${DATA_FILE}`);
  if (!AUTH_TOKEN) {
    console.warn(
      "[telementary] WARNING: TELEMETRY_TOKEN is not set — all telemetry requests are rejected."
    );
  }
});
