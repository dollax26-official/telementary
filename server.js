/**
 * Telementary — telemetry API for Minecraft activity data.
 *
 * Supports:
 *   GET  /                  -> service info
 *   GET  /api/health       -> health check
 *   POST /api/register     -> automatically register a Minecraft client
 *   POST /api/telemetry    -> store telemetry
 *   GET  /api/telemetry    -> read telemetry (master token only)
 *
 * Environment:
 *   TELEMETRY_TOKEN  -> private master/admin token
 *   PORT             -> Railway HTTP port
 *   DATA_DIR         -> data directory
 *   MAX_RECORDS      -> maximum telemetry records
 */

"use strict";

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 8080;
const AUTH_TOKEN = process.env.TELEMETRY_TOKEN || "";
const DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const DATA_FILE = path.join(DATA_DIR, "telemetry.json");
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const WORLD_DIR = path.join(DATA_DIR, "worlds");
const WORLDS_FILE = path.join(DATA_DIR, "worlds.json");

const MAX_RECORDS =
  Number(process.env.MAX_RECORDS) || 5000;

const app = express();


/* CORS support for the Fern Android app */
app.use((req, res, next) => {
  const origin = req.get("Origin");

  // Only allow the local origins used by the app.
  if (
    origin === "https://localhost" ||
    origin === "http://localhost"
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type"
    );
  }

  // Preflight requests must not require the API token.
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});


app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "1mb",
  })
);

/* --------------------------------------------------------------- storage */

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});
fs.mkdirSync(WORLD_DIR, { recursive: true });

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(
    DATA_FILE,
    "[]\n",
    "utf8"
  );
}

if (!fs.existsSync(DEVICES_FILE)) {
  fs.writeFileSync(
    DEVICES_FILE,
    "[]\n",
    "utf8"
  );
}

if (!fs.existsSync(WORLDS_FILE)) {
  fs.writeFileSync(WORLDS_FILE, "[]\n", "utf8");
}

function loadJsonFile(file) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(file, "utf8")
    );

    return Array.isArray(parsed)
      ? parsed
      : [];
  } catch (error) {
    console.error(
      `[telementary] could not read ${file}:`,
      error.message
    );

    return [];
  }
}

function saveJsonFile(file, data) {
  const tmpFile = `${file}.tmp`;

  fs.writeFileSync(
    tmpFile,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(
    tmpFile,
    file
  );
}

function loadRecords() {
  return loadJsonFile(DATA_FILE);
}

function saveRecords(records) {
  saveJsonFile(
    DATA_FILE,
    records
  );
}

function loadDevices() {
  return loadJsonFile(DEVICES_FILE);
}

function saveDevices(devices) {
  saveJsonFile(
    DEVICES_FILE,
    devices
  );
}

function loadWorlds() {
  return loadJsonFile(WORLDS_FILE);
}

function saveWorlds(worlds) {
  saveJsonFile(WORLDS_FILE, worlds);
}

function safeWorldName(value) {
  const name = String(value || "Minecraft World").trim().slice(0, 80);
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\.+$/g, "") || "Minecraft World";
}

function worldSlug(value) {
  return safeWorldName(value).replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "world";
}

/* ------------------------------------------------------------------ auth */

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    bufferA,
    bufferB
  );
}

function extractToken(req) {
  const authorization =
    req.get("authorization") || "";

  const bearer =
    authorization
      .toLowerCase()
      .startsWith("bearer ")
      ? authorization.slice(7).trim()
      : "";

  return (
    bearer ||
    req.get("x-telemetry-token") ||
    req.get("x-api-key") ||
    ""
  );
}

function isMasterAuthorized(req) {
  if (!AUTH_TOKEN) {
    return false;
  }

  const token = extractToken(req);

  return (
    token.length > 0 &&
    safeEqual(token, AUTH_TOKEN)
  );
}

function findDeviceByToken(token) {
  if (!token) {
    return null;
  }

  const devices = loadDevices();

  for (const device of devices) {
    if (
      device.token &&
      safeEqual(token, device.token)
    ) {
      return device;
    }
  }

  return null;
}

function getTelemetryAuthorization(req) {
  const token = extractToken(req);

  if (!token) {
    return null;
  }

  if (AUTH_TOKEN && safeEqual(token, AUTH_TOKEN)) {
    return {
      type: "master",
      device: null,
    };
  }

  const device = findDeviceByToken(token);

  if (device) {
    return {
      type: "device",
      device,
    };
  }

  return null;
}

/* --------------------------------------------------------- registration */

/*
 * Basic in-memory registration rate limiting.
 *
 * This prevents a single IP from creating thousands
 * of registrations in a short period.
 */
const registrationAttempts =
  new Map();

const REGISTRATION_WINDOW_MS =
  10 * 60 * 1000;

const MAX_REGISTRATIONS_PER_WINDOW =
  10;

function registrationAllowed(ip) {
  const now = Date.now();

  const previous =
    registrationAttempts.get(ip);

  if (!previous) {
    registrationAttempts.set(ip, {
      count: 1,
      firstAttempt: now,
    });

    return true;
  }

  if (
    now - previous.firstAttempt >
    REGISTRATION_WINDOW_MS
  ) {
    registrationAttempts.set(ip, {
      count: 1,
      firstAttempt: now,
    });

    return true;
  }

  if (
    previous.count >=
    MAX_REGISTRATIONS_PER_WINDOW
  ) {
    return false;
  }

  previous.count++;

  return true;
}

/* ------------------------------------------------------------------- app */

app.get("/", (req, res) => {
  res.json({
    service: "telementary",

    description:
      "Telemetry receiver for Minecraft activity data.",

    endpoints: {
      health: "GET /api/health",
      register: "POST /api/register",
      store: "POST /api/telemetry",
      read: "GET /api/telemetry?limit=100",
    },
  });
});

/* --------------------------------------------------------------- health */

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    version: "2.1.0",
    uptimeSeconds:
      Math.round(process.uptime()),
    time: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------ register */

/*
 * A new Fern installation calls this endpoint automatically.
 *
 * IMPORTANT:
 * This endpoint does NOT expose the master TELEMETRY_TOKEN.
 *
 * It creates a separate token that can only submit telemetry.
 */
app.post("/api/register", (req, res) => {
  const ip =
    req.ip || "unknown";

  if (!registrationAllowed(ip)) {
    return res.status(429).json({
      ok: false,
      error:
        "too many registration attempts",
    });
  }

  const body =
    req.body &&
    typeof req.body === "object"
      ? req.body
      : {};

  const deviceId =
    typeof body.deviceId === "string" &&
    body.deviceId.length <= 128
      ? body.deviceId
      : crypto.randomUUID();

  const username =
    typeof body.username === "string" &&
    body.username.length <= 64
      ? body.username
      : "unknown";

  const minecraftVersion =
    typeof body.minecraftVersion === "string" &&
    body.minecraftVersion.length <= 32
      ? body.minecraftVersion
      : "unknown";

  const uuid = typeof body.uuid === "string" && body.uuid.length <= 64
    ? body.uuid
    : "";

  const devices = loadDevices();

  /*
   * If this exact installation already registered,
   * return its existing token.
   */
  const existing =
    devices.find(
      (device) =>
        device.deviceId === deviceId
    );

  if (existing) {
    return res.json({
      ok: true,
      existing: true,
      token: existing.token,
    });
  }

  const token =
    crypto.randomBytes(32).toString("hex");

  const device = {
    deviceId,
    token,
    username,
    uuid,
    minecraftVersion,
    registeredAt:
      new Date().toISOString(),
    lastSeenAt:
      new Date().toISOString(),
    lastIp: ip,
  };

  devices.push(device);

  saveDevices(devices);

  console.log(
    `[telementary] registered device ${deviceId} (${username})`
  );

  return res.status(201).json({
    ok: true,
    existing: false,
    token,
  });
});

/* -------------------------------------------------------------- telemetry */

app.post("/api/telemetry", (req, res) => {
  const authorization =
    getTelemetryAuthorization(req);

  if (!authorization) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  if (!req.is("application/json")) {
    return res
      .status(415)
      .json({
        ok: false,
        error:
          "Content-Type must be application/json",
      });
  }

  const body = req.body;

  if (
    !body ||
    typeof body !== "object"
  ) {
    return res
      .status(400)
      .json({
        ok: false,
        error:
          "body must be a JSON object or array",
      });
  }

  const incoming =
    Array.isArray(body)
      ? body
      : [body];

  if (incoming.length === 0) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "payload is empty",
      });
  }

  if (incoming.length > 500) {
    return res
      .status(413)
      .json({
        ok: false,
        error:
          "too many records in one request (max 500)",
      });
  }

  const receivedAt =
    new Date().toISOString();

  const remoteAddress =
    req.ip;

  const records =
    loadRecords();

  /*
   * Device tokens are allowed to submit telemetry,
   * but their token is NOT stored inside the
   * telemetry record.
   */
  for (const payload of incoming) {
    records.push({
      receivedAt,
      remoteAddress,

      source:
        authorization.type === "master"
          ? "master"
          : "device",

      deviceId:
        authorization.device
          ? authorization.device.deviceId
          : null,

      payload,
    });
  }

  const trimmed =
    records.length > MAX_RECORDS
      ? records.slice(-MAX_RECORDS)
      : records;

  saveRecords(trimmed);

  /*
   * Update device last-seen information.
   */
  if (
    authorization.type === "device" &&
    authorization.device
  ) {
    const devices =
      loadDevices();

    const device =
      devices.find(
        (item) =>
          item.deviceId ===
          authorization.device.deviceId
      );

    if (device) {
      device.lastSeenAt =
        receivedAt;

      device.lastIp =
        remoteAddress;

      saveDevices(devices);
    }
  }

  console.log(
    `[telementary] stored ${incoming.length} record(s) from ${remoteAddress}`
  );

  return res
    .status(202)
    .json({
      ok: true,
      received:
        incoming.length,
      stored:
        trimmed.length,
    });
});

/* --------------------------------------------------------------- reading */

/*
 * ONLY your master TELEMETRY_TOKEN can read telemetry.
 *
 * A brother/device token cannot download
 * everyone else's telemetry.
 */
app.get("/api/telemetry", (req, res) => {
  if (!isMasterAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  const limit = Math.min(
    Math.max(
      Number(req.query.limit) || 100,
      1
    ),
    1000
  );

  const offset =
    Math.max(
      Number(req.query.offset) || 0,
      0
    );

  const records =
    loadRecords();

  const end =
    Math.max(
      records.length - offset,
      0
    );

  const start =
    Math.max(
      end - limit,
      0
    );

  res.json({
    ok: true,
    total:
      records.length,

    offset,

    returned:
      end - start,

    records:
      records.slice(
        start,
        end
      ),
  });
});

/* ---------------------------------------------------------------- devices */

/*
 * Device management is master-token only.
 *
 * Useful later for your dashboard.
 */
app.get("/api/devices", (req, res) => {
  if (!isMasterAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
    });
  }

  const devices =
    loadDevices();

  /*
   * Never send device tokens back to the dashboard.
   */
  const safeDevices =
    devices.map((device) => ({
      deviceId:
        device.deviceId,

      username:
        device.username,

      uuid:
        device.uuid || null,

      minecraftVersion:
        device.minecraftVersion,

      registeredAt:
        device.registeredAt,

      lastSeenAt:
        device.lastSeenAt,

      lastIp:
        device.lastIp,
    }));

  res.json({
    ok: true,
    total:
      safeDevices.length,
    devices:
      safeDevices,
  });
});


/* ---------------------------------------------------------- world backups */

/*
 * World archive uploads are disabled unless the client explicitly opts in.
 * The client token identifies the owner; the master token is read-only here.
 * Keep DATA_DIR on a Railway persistent volume if backups must survive deploys.
 */
app.post(
  "/api/worlds",
  express.raw({ type: ["application/zip", "application/x-zip-compressed"], limit: "100mb" }),
  (req, res) => {
    const authorization = getTelemetryAuthorization(req);
    if (!authorization || authorization.type !== "device" || !authorization.device) {
      return res.status(401).json({ ok: false, error: "device token required" });
    }
    if (req.get("x-world-backup-consent") !== "true") {
      return res.status(403).json({ ok: false, error: "world backup consent is required" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 4) {
      return res.status(400).json({ ok: false, error: "upload must be a ZIP archive" });
    }
    const signature = req.body.subarray(0, 4).toString("hex");
    if (!["504b0304", "504b0506", "504b0708"].includes(signature)) {
      return res.status(415).json({ ok: false, error: "upload is not a valid ZIP archive" });
    }

    const device = authorization.device;
    const worldName = safeWorldName(req.get("x-world-name") || "Minecraft World");
    const player = String(req.get("x-minecraft-username") || device.username || "unknown").trim().slice(0, 64);
    const id = crypto.randomUUID();
    const archiveFile = id + ".zip";
    const archivePath = path.join(WORLD_DIR, archiveFile);

    try {
      fs.writeFileSync(archivePath, req.body, { flag: "wx" });
      const worlds = loadWorlds();
      const metadata = {
        id,
        deviceId: device.deviceId,
        player,
        uuid: device.uuid || null,
        worldName,
        uploadedAt: new Date().toISOString(),
        sizeBytes: req.body.length,
        archiveFile
      };
      worlds.push(metadata);
      saveWorlds(worlds);
      return res.status(201).json({
        ok: true,
        world: {
          id: metadata.id,
          player: metadata.player,
          worldName: metadata.worldName,
          uploadedAt: metadata.uploadedAt,
          sizeBytes: metadata.sizeBytes
        }
      });
    } catch (error) {
      try { fs.rmSync(archivePath, { force: true }); } catch {}
      console.error("[telementary] world backup save failed:", error.message);
      return res.status(500).json({ ok: false, error: "could not save world backup" });
    }
  }
);

app.get("/api/worlds", (req, res) => {
  if (!isMasterAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const worlds = loadWorlds()
    .map(({ id, deviceId, player, uuid, worldName, uploadedAt, sizeBytes }) => ({
      id, deviceId, player, uuid: uuid || null, worldName, uploadedAt, sizeBytes
    }))
    .sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
  return res.json({ ok: true, total: worlds.length, worlds });
});

app.get("/api/worlds/:id/download", (req, res) => {
  if (!isMasterAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const id = String(req.params.id || "");
  const worlds = loadWorlds();
  const world = worlds.find((entry) => entry.id === id);
  if (!world || !/^[0-9a-f-]{36}$/i.test(world.id)) {
    return res.status(404).json({ ok: false, error: "world backup not found" });
  }
  const archivePath = path.join(WORLD_DIR, world.archiveFile);
  if (!fs.existsSync(archivePath)) {
    return res.status(410).json({ ok: false, error: "world archive is no longer available" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.download(archivePath, `${worldSlug(world.player)}-${worldSlug(world.worldName)}.zip`);
});

/* --------------------------------------------------------------- fallback */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "not found",
  });
});

/* --------------------------------------------------------------- errors */

app.use(
  (error, req, res, next) => {
    if (
      error &&
      error.type ===
        "entity.parse.failed"
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "invalid JSON body",
        });
    }

    console.error(
      "[telementary] unexpected error:",
      error
    );

    res.status(500).json({
      ok: false,
      error:
        "internal server error",
    });
  }
);

/* ---------------------------------------------------------------- listen */

app.listen(PORT, () => {
  console.log(
    `[telementary] listening on port ${PORT}`
  );

  console.log(
    `[telementary] data file: ${DATA_FILE}`
  );

  console.log(
    `[telementary] devices file: ${DEVICES_FILE}`
  );

  if (!AUTH_TOKEN) {
    console.warn(
      "[telementary] WARNING: TELEMETRY_TOKEN is not set — master telemetry access is disabled."
    );
  }
});
