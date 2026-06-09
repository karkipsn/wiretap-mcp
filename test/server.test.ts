/**
 * TRACER-004 acceptance tests (file mode). Run with: `npm test`.
 *
 * AC-2 is the anti-drift guard: it asserts the Node timeline output is byte-identical
 * to `fixtures/golden.llm.md`, which was emitted by the Swift TRACER-003 renderer.
 * Regenerate the golden from Swift if the format intentionally changes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import * as tools from "../src/tools.js";
import { TOOL_NAMES } from "../src/tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures");
const golden = path.join(fixtures, "golden.wiretapsession");

/** Write a temporary session file and return its path. */
async function tmpSession(obj: unknown): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wiretap-mcp-test-"));
  const file = path.join(dir, "s.wiretapsession");
  await fs.writeFile(file, JSON.stringify(obj));
  return { dir, file };
}

const mixedSession = {
  schemaVersion: 1,
  app: { bundleId: "x", version: "1" },
  environment: { os: "iOS", osVersion: "17" },
  range: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:00:05.000Z" },
  network: [
    { timestamp: "2026-01-01T00:00:01.000Z", method: "GET", url: "https://x/ok", statusCode: 200, durationMs: 10 },
    { timestamp: "2026-01-01T00:00:02.000Z", method: "POST", url: "https://x/fail", statusCode: 500, durationMs: 20 },
    { timestamp: "2026-01-01T00:00:03.000Z", method: "GET", url: "https://x/err", durationMs: 0, error: "timeout" },
  ],
  ble: [
    { timestamp: "2026-01-01T00:00:01.500Z", type: "connected", device: "MS2" },
    { timestamp: "2026-01-01T00:00:04.000Z", type: "disconnected", device: "MS2", error: "dropped" },
  ],
  nfc: [{ timestamp: "2026-01-01T00:00:00.500Z", type: "scanCompleted", detail: "MS2" }],
};

// AC-1 — lists sessions in a directory
test("AC-1 listSessions finds files in a directory", async () => {
  const out = await tools.listSessions(fixtures);
  assert.match(out, /golden\.wiretapsession/);
  assert.match(out, /network=\d+ ble=\d+ nfc=\d+/);
});

// AC-2 — timeline is byte-identical to the Swift renderer's golden output
test("AC-2 timeline matches the Swift golden (no drift)", async () => {
  const expected = await fs.readFile(path.join(fixtures, "golden.llm.md"), "utf8");
  const actual = await tools.getTimeline({ session: golden });
  assert.equal(actual, expected);
});

// AC-3 — BLE query filters correctly
test("AC-3 queryBle filters by type", async () => {
  const { dir, file } = await tmpSession(mixedSession);
  const out = await tools.queryBle({ session: file, type: "disconnected" });
  assert.match(out, /disconnected/);
  assert.doesNotMatch(out, /connected device=MS2\n.*connected/); // only the disconnected row
  assert.match(out, /ERR=dropped|dropped/);
  await fs.rm(dir, { recursive: true, force: true });
});

// AC-4 — network failures only
test("AC-4 getNetworkFailures returns only non-2xx / errored", async () => {
  const { dir, file } = await tmpSession(mixedSession);
  const out = await tools.getNetworkFailures({ session: file });
  assert.match(out, /https:\/\/x\/fail/);
  assert.match(out, /https:\/\/x\/err/);
  assert.doesNotMatch(out, /https:\/\/x\/ok/); // the 200 must be excluded
  await fs.rm(dir, { recursive: true, force: true });
});

// AC-5 — no-session is graceful (no throw)
test("AC-5 missing session is handled gracefully", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "wiretap-mcp-empty-"));
  const out = await tools.getOverview(empty);
  assert.match(out, /No \.wiretapsession files found|no events/i);
  await fs.rm(empty, { recursive: true, force: true });
});

// AC-6 — responses are bounded
test("AC-6 timeline honors the per-stream limit with a truncation note", async () => {
  const many = {
    schemaVersion: 1,
    app: { bundleId: "x", version: "1" },
    environment: { os: "iOS", osVersion: "17" },
    range: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:10:00.000Z" },
    network: Array.from({ length: 500 }, (_, i) => ({
      timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
      method: "GET",
      url: `https://x/${i}`,
      statusCode: 200,
      durationMs: i,
    })),
    ble: [],
    nfc: [],
  };
  const { dir, file } = await tmpSession(many);
  const out = await tools.getTimeline({ session: file, limit: 50 });
  assert.match(out, /showing newest 50 of 500/);
  const netLines = out.split("\n").filter((l) => l.includes(" net "));
  assert.equal(netLines.length, 50);
  await fs.rm(dir, { recursive: true, force: true });
});

// AC-7 — read-only guarantee: no tool name implies mutation
test("AC-7 all tools are read-only by name", () => {
  const mutating = /(write|set|delete|remove|modify|replay|inject|clear|update|patch|put|post)/i;
  for (const name of TOOL_NAMES) {
    assert.ok(!mutating.test(name), `tool "${name}" looks mutating`);
  }
  assert.equal(TOOL_NAMES.length, 7);
});

// Coverage: wiretap_get_overview
test("get_overview returns error counts and session header", async () => {
  const { dir, file } = await tmpSession(mixedSession);
  const out = await tools.getOverview(file);
  assert.match(out, /errors: network=2 ble=1/);
  assert.match(out, /https:\/\/x\/fail/);
  assert.match(out, /https:\/\/x\/err/);
  assert.match(out, /dropped/);
  await fs.rm(dir, { recursive: true, force: true });
});

// Coverage: wiretap_get_nfc_records
test("get_nfc_records lists NFC events", async () => {
  const { dir, file } = await tmpSession(mixedSession);
  const out = await tools.getNfcRecords(file);
  assert.match(out, /nfc events/i);
  assert.match(out, /scanCompleted/);
  assert.match(out, /MS2/);
  await fs.rm(dir, { recursive: true, force: true });
});

// Coverage: wiretap_search
test("search finds matching events across all streams", async () => {
  const { dir, file } = await tmpSession(mixedSession);
  // "MS2" appears in BLE device and NFC detail
  const out = await tools.search({ session: file, query: "MS2" });
  assert.match(out, /MS2/);
  assert.match(out, /search "MS2"/);
  // searching for something absent returns no matches
  const none = await tools.search({ session: file, query: "ZZZNOTFOUND" });
  assert.match(none, /no matches/i);
  await fs.rm(dir, { recursive: true, force: true });
});
