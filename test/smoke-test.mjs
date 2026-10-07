/**
 * Self-contained smoke test.
 *
 * Starts the server on a random port with a temporary data directory,
 * exercises every endpoint, then shuts it down.
 *
 * Run with: npm test
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 40000 + Math.floor(Math.random() * 20000);
const TOKEN = "smoke-test-token";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "telementary-smoke-"));

let failures = 0;

function check(name, passed, detail = "") {
  if (passed) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const sample = {
  player: "Player786",
  uuid: "8280f006-3f61-3ece-adfd-8952041aff70",
  minecraftVersion: "Fabric",
  sessions: [
    {
      server: "example.com",
      joined: "2026-10-07T15:22:57Z",
      commands: [{ time: "2026-10-07T15:23:01Z", command: "/help" }],
      left: "2026-10-07T15:24:04Z",
    },
  ],
  singlePlayerWorlds: [
    { name: "My Survival World", lastPlayed: "2026-10-07T15:00:00Z", playTime: "12h" },
  ],
};

const child = spawn(process.execPath, [path.join(root, "server.js")], {
  env: { ...process.env, PORT: String(PORT), TELEMETRY_TOKEN: TOKEN, DATA_DIR },
  stdio: "inherit",
});

try {
  check("server starts and answers /api/health", await waitForHealth());

  const unauthorized = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sample),
  });
  check(
    "rejects missing token with 401",
    unauthorized.status === 401,
    `got ${unauthorized.status}`
  );

  const stored = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(sample),
  });
  check(
    "accepts authenticated POST with 202",
    stored.status === 202,
    `got ${stored.status}`
  );

  const batch = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telemetry-token": TOKEN },
    body: JSON.stringify([sample, sample]),
  });
  check("accepts a batch of records", batch.status === 202, `got ${batch.status}`);

  const readBack = await fetch(`${BASE}/api/telemetry?limit=10`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const data = await readBack.json();
  check(
    "stores and returns records in order",
    readBack.status === 200 &&
      data.total === 3 &&
      data.records[2].payload.player === "Player786",
    JSON.stringify(data).slice(0, 160)
  );

  const page1 = await fetch(`${BASE}/api/telemetry?limit=1&offset=0`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const page1Data = await page1.json();
  check(
    "supports limit/offset pagination",
    page1.status === 200 &&
      page1Data.total === 3 &&
      page1Data.offset === 0 &&
      page1Data.returned === 1,
    JSON.stringify(page1Data).slice(0, 160)
  );

  const page2 = await fetch(`${BASE}/api/telemetry?limit=1&offset=2`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const page2Data = await page2.json();
  check(
    "offset skips the newest records",
    page2.status === 200 && page2Data.returned === 1,
    JSON.stringify(page2Data).slice(0, 160)
  );

  const page3 = await fetch(`${BASE}/api/telemetry?limit=10&offset=100`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const page3Data = await page3.json();
  check(
    "offset beyond the window returns an empty page",
    page3.status === 200 && page3Data.returned === 0 && page3Data.records.length === 0
  );

  const badJson = await fetch(`${BASE}/api/telemetry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    },
    body: "{definitely not json",
  });
  check("rejects malformed JSON with 400", badJson.status === 400, `got ${badJson.status}`);

  const missing = await fetch(`${BASE}/does-not-exist`);
  check("unknown routes return 404", missing.status === 404);
} finally {
  child.kill();
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
}

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("All smoke tests passed");
}
