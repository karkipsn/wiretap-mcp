/**
 * Loading and normalizing WireTap sessions from disk.
 *
 * Resolution order for "which session?":
 *   1. An explicit path passed by a tool call (file or directory).
 *   2. The server's default source (CLI arg, or WIRETAP_SESSION / WIRETAP_SESSIONS_DIR env).
 *   3. The current working directory.
 *
 * If the resolved path is a directory, the most recently modified `.wiretapsession`
 * (or `.json`) file in it is used.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  WireTapSession,
  TimelineItem,
  Stream,
  SUPPORTED_SCHEMA_MAJOR,
} from "./types.js";

const SESSION_EXTENSIONS = [".wiretapsession", ".json"];

export class SessionError extends Error {}

/** The server's default session source, set once at startup from argv/env. */
let defaultSource: string = resolveStartupSource();

function resolveStartupSource(): string {
  const arg = process.argv[2];
  if (arg && !arg.startsWith("-")) return path.resolve(arg);
  if (process.env.WIRETAP_SESSION) return path.resolve(process.env.WIRETAP_SESSION);
  if (process.env.WIRETAP_SESSIONS_DIR) return path.resolve(process.env.WIRETAP_SESSIONS_DIR);
  return process.cwd();
}

export function getDefaultSource(): string {
  return defaultSource;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** All session files in a directory, newest first. */
export async function findSessionFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const candidates = names
    .filter((n) => SESSION_EXTENSIONS.includes(path.extname(n).toLowerCase()))
    .map((n) => path.join(dir, n));

  const withTimes = await Promise.all(
    candidates.map(async (p) => ({ p, mtime: (await fs.stat(p)).mtimeMs }))
  );
  return withTimes.sort((a, b) => b.mtime - a.mtime).map((x) => x.p);
}

/** Resolve an explicit-or-default source to a concrete session file path. */
export async function resolveSessionFile(explicit?: string): Promise<string> {
  const source = explicit ? path.resolve(explicit) : defaultSource;

  if (await isDirectory(source)) {
    const files = await findSessionFiles(source);
    if (files.length === 0) {
      throw new SessionError(
        `No .wiretapsession files found in directory: ${source}`
      );
    }
    return files[0];
  }
  return source;
}

/** Hex-normalize a payload that may arrive as hex, dataHex, or base64 `data`. */
function normalizeHex(raw: any): string | null {
  if (typeof raw.hex === "string") return cleanHex(raw.hex);
  if (typeof raw.dataHex === "string") return cleanHex(raw.dataHex);
  if (typeof raw.data === "string") {
    // assume base64
    try {
      return Buffer.from(raw.data, "base64").toString("hex");
    } catch {
      return null;
    }
  }
  return null;
}

function cleanHex(s: string): string {
  return s.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function asArray<T>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

/** Parse + validate + normalize a session file. */
export async function loadSession(explicit?: string): Promise<{
  file: string;
  session: WireTapSession;
}> {
  const file = await resolveSessionFile(explicit);

  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e: any) {
    throw new SessionError(`Could not read session file ${file}: ${e.message}`);
  }

  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e: any) {
    throw new SessionError(`File ${file} is not valid JSON: ${e.message}`);
  }

  const version = Number(raw.schemaVersion ?? 1);
  if (Math.floor(version) > SUPPORTED_SCHEMA_MAJOR) {
    throw new SessionError(
      `Unsupported schema version ${version} (this server supports major ${SUPPORTED_SCHEMA_MAJOR}). Update wiretap-mcp.`
    );
  }

  const session: WireTapSession = {
    schemaVersion: version,
    exportedAt: raw.exportedAt,
    app: raw.app,
    environment: raw.environment,
    range: raw.range ?? null,
    network: asArray<any>(raw.network).map((e) => ({ ...e })),
    ble: asArray<any>(raw.ble).map((e) => ({ ...e, hex: normalizeHex(e) })),
    nfc: asArray<any>(raw.nfc).map((e) => ({ ...e, hex: normalizeHex(e) })),
  };

  // Ensure each stream is ascending by timestamp.
  const byTime = (a: { timestamp: string }, b: { timestamp: string }) =>
    a.timestamp.localeCompare(b.timestamp);
  session.network.sort(byTime);
  session.ble.sort(byTime);
  session.nfc.sort(byTime);

  return { file, session };
}

/** Merge all three streams into one ascending-time timeline. */
export function mergeTimeline(
  session: WireTapSession,
  summarize: {
    network: (e: any) => string;
    ble: (e: any) => string;
    nfc: (e: any) => string;
  }
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...session.network.map((e) => mk("network", e.timestamp, summarize.network(e))),
    ...session.ble.map((e) => mk("ble", e.timestamp, summarize.ble(e))),
    ...session.nfc.map((e) => mk("nfc", e.timestamp, summarize.nfc(e))),
  ];
  // ascending by time; ties broken by kind then summary for determinism
  return items.sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      a.kind.localeCompare(b.kind) ||
      a.summary.localeCompare(b.summary)
  );

  function mk(kind: Stream, timestamp: string, summary: string): TimelineItem {
    return { kind, timestamp: timestamp ?? "", summary };
  }
}
