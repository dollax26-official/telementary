#!/usr/bin/env node
/**
 * sync.js — local backup tool.
 *
 * Downloads every telemetry record from the Railway server and stores it on
 * this computer, then generates a readable viewer page.
 *
 * Configuration (in .env, next to this file):
 *   SYNC_SERVER_URL  https://your-app.up.railway.app
 *   TELEMETRY_TOKEN  the same secret you set in Railway
 *
 * Usage:
 *   npm run sync             (or double-click sync.bat on Windows)
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const DATA_DIR = process.env.SYNC_DATA_DIR
  ? path.resolve(process.env.SYNC_DATA_DIR)
  : path.join(ROOT, "local-data");
const ARCHIVE_FILE = path.join(DATA_DIR, "telemetry.json");
const VIEWER_FILE = path.join(DATA_DIR, "viewer.html");
const PAGE_SIZE = 1000;
const MAX_PAGES = 100; // safety cap (100 x 1000 records)

/* --------------------------------------------------------------- config */

function readEnvFile() {
  const file = path.join(ROOT, ".env");
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const envFile = readEnvFile();
const SERVER_URL = String(
  process.env.SYNC_SERVER_URL || envFile.SYNC_SERVER_URL || ""
).replace(/\/+$/, "");
const TOKEN = process.env.TELEMETRY_TOKEN || envFile.TELEMETRY_TOKEN || "";

if (!SERVER_URL.startsWith("http")) {
  console.error("[sync] SYNC_SERVER_URL is not set. Add it to .env, for example:");
  console.error("       SYNC_SERVER_URL=https://telementary-xxxx.up.railway.app");
  process.exit(1);
}
if (!TOKEN) {
  console.error(
    "[sync] TELEMETRY_TOKEN is not set. Add it to .env (the same value you set in Railway)."
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- fetch */

async function fetchPage(offset) {
  const url = `${SERVER_URL}/api/telemetry?limit=${PAGE_SIZE}&offset=${offset}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (response.status === 401) {
    throw new Error(
      "the server rejected the token (401) — TELEMETRY_TOKEN in .env must match the Railway variable"
    );
  }
  if (!response.ok) {
    throw new Error(`server responded with HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchEverything() {
  const pages = [];
  let offset = 0;
  let total = 0;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await fetchPage(offset);
    total = page.total;
    pages.push(page.records);
    offset += page.returned;
    if (page.returned === 0 || offset >= total) break;
  }
  return { records: pages.reverse().flat(), total };
}

/* -------------------------------------------------------------- archive */

function loadArchive() {
  if (!fs.existsSync(ARCHIVE_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn(
      `[sync] could not read the local archive (${error.message}); starting a new one.`
    );
    return [];
  }
}

const recordKey = (record) =>
  `${record.receivedAt}|${record.remoteAddress}|${JSON.stringify(record.payload)}`;

/* --------------------------------------------------------------- viewer */

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderRecord(record) {
  const payload = record.payload || {};
  const parts = [];
  parts.push('<article class="card">');
  parts.push("<header>");
  parts.push(
    `<span class="time">${escapeHtml(record.receivedAt || "unknown time")}</span>`
  );
  if (payload.player) {
    parts.push(`<span class="chip">${escapeHtml(payload.player)}</span>`);
  }
  if (payload.minecraftVersion) {
    parts.push(
      `<span class="chip">${escapeHtml(payload.minecraftVersion)}</span>`
    );
  }
  parts.push("</header>");

  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (sessions.length) {
    parts.push(
      "<table><tr><th>Server</th><th>Joined</th><th>Left</th><th>Commands used</th></tr>"
    );
    for (const session of sessions) {
      const commands = Array.isArray(session.commands) ? session.commands : [];
      const commandText = commands.length
        ? commands
            .map((entry) => `<code>${escapeHtml(entry.command)}</code>`)
            .join(" ")
        : "–";
      parts.push(
        `<tr><td>${escapeHtml(session.server || "–")}</td>` +
          `<td>${escapeHtml(session.joined || "–")}</td>` +
          `<td>${escapeHtml(session.left || "still playing")}</td>` +
          `<td>${commandText}</td></tr>`
      );
    }
    parts.push("</table>");
  }

  const worlds = Array.isArray(payload.singlePlayerWorlds)
    ? payload.singlePlayerWorlds
    : [];
  if (worlds.length) {
    parts.push("<h4>Single-player worlds</h4><ul>");
    for (const world of worlds) {
      parts.push(
        `<li><strong>${escapeHtml(world.name || "unnamed")}</strong> — last played ${escapeHtml(
          world.lastPlayed || "?"
        )}, play time ${escapeHtml(world.playTime || "?")}</li>`
      );
    }
    parts.push("</ul>");
  }

  if (!sessions.length && !worlds.length) {
    parts.push(`<pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`);
  }

  parts.push("</article>");
  return parts.join("\n");
}

function buildViewer(records) {
  const players = [
    ...new Set(
      records.map((record) => record.payload && record.payload.player).filter(Boolean)
    ),
  ];
  const first = records.length ? records[0].receivedAt : null;
  const last = records.length ? records[records.length - 1].receivedAt : null;
  const cards = records
    .slice()
    .reverse()
    .map(renderRecord)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telementary — local backup</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f5f6f8; color: #1c1e21; }
  main { max-width: 920px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #667; margin-bottom: 20px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .stat { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 10px 14px; min-width: 120px; }
  .stat b { display: block; font-size: 18px; }
  .stat span { color: #667; font-size: 12.5px; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
  .card header { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .time { color: #667; font-size: 13px; }
  .chip { background: #eef1ff; color: #3346c0; border-radius: 999px; padding: 2px 10px; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  th, td { text-align: left; border-bottom: 1px solid #eceef2; padding: 6px 8px; vertical-align: top; }
  th { color: #667; font-weight: 600; }
  code { background: #f0f2f6; border-radius: 4px; padding: 1px 5px; }
  pre { background: #f0f2f6; border-radius: 8px; padding: 10px; overflow: auto; font-size: 12.5px; }
  h4 { margin: 12px 0 6px; }
  .empty { background: #fff; border: 1px dashed #c9ced8; border-radius: 12px; padding: 30px; text-align: center; color: #667; }
</style>
</head>
<body>
<main>
  <h1>Telementary — local backup</h1>
  <div class="sub">Generated ${escapeHtml(new Date().toISOString())} by sync.js · pulled from your Railway telemetry server.</div>
  <div class="stats">
    <div class="stat"><b>${records.length}</b><span>records</span></div>
    <div class="stat"><b>${players.length ? escapeHtml(players.join(", ")) : "–"}</b><span>player(s)</span></div>
    <div class="stat"><b>${first ? escapeHtml(String(first).slice(0, 19).replace("T", " ")) : "–"}</b><span>oldest</span></div>
    <div class="stat"><b>${last ? escapeHtml(String(last).slice(0, 19).replace("T", " ")) : "–"}</b><span>newest</span></div>
  </div>
  ${
    cards ||
    '<div class="empty">No telemetry yet. Once Fern uploads to your Railway server, run the sync again and the data will show up here.</div>'
  }
</main>
</body>
</html>
`;
}

/* ----------------------------------------------------------------- main */

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log(`[sync] server: ${SERVER_URL}`);

  const { records: remoteRecords, total } = await fetchEverything();
  console.log(
    `[sync] server reports ${total} record(s); fetched ${remoteRecords.length}.`
  );

  const archive = loadArchive();
  const seen = new Set(archive.map(recordKey));
  let added = 0;
  for (const record of remoteRecords) {
    const key = recordKey(record);
    if (!seen.has(key)) {
      seen.add(key);
      archive.push(record);
      added += 1;
    }
  }
  archive.sort((a, b) =>
    String(a.receivedAt).localeCompare(String(b.receivedAt))
  );

  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2), "utf8");
  fs.writeFileSync(VIEWER_FILE, buildViewer(archive), "utf8");

  console.log(
    `[sync] added ${added} new record(s); local archive now has ${archive.length}.`
  );
  console.log(`[sync] saved:  ${path.relative(ROOT, ARCHIVE_FILE)}`);
  console.log(`[sync] viewer: ${path.relative(ROOT, VIEWER_FILE)} (open in your browser)`);
}

main().catch((error) => {
  console.error(`[sync] failed: ${error.message}`);
  process.exitCode = 1;
});
