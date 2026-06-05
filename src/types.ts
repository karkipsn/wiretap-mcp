/**
 * The WireTap session contract — the JSON shape any app emits and this server reads.
 *
 * This is intentionally language-agnostic. A native iOS app (the Swift `WireTap`
 * package, TRACER-002), a React Native app, or a Flutter app can all produce a
 * `.wiretapsession` file in this shape; the MCP server neither knows nor cares which.
 *
 * Payloads (BLE/NFC bytes) are carried as a `hex` string. Loaders also accept
 * `dataHex` or base64 `data` and normalize to `hex` (see session.ts) so we tolerate
 * minor exporter differences.
 */

export type Stream = "network" | "ble" | "nfc";

export interface AppInfo {
  bundleId?: string;
  name?: string;
  version?: string;
  build?: string;
}

export interface EnvInfo {
  os?: string;
  osVersion?: string;
  device?: string;
  locale?: string;
}

export interface NetworkEntry {
  id?: string;
  timestamp: string; // ISO-8601
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  statusCode?: number | null;
  responseHeaders?: Record<string, string>;
  responseBody?: string | null;
  durationMs?: number;
  error?: string | null;
}

export interface BleEntry {
  id?: string;
  timestamp: string; // ISO-8601
  type: string; // connected, disconnected, serviceDiscovered, pairingStarted, authFailed, …
  uuid?: string | null;
  device?: string | null;
  hex?: string | null; // payload bytes as space-free or spaced hex
  detail?: string | null;
  error?: string | null;
  decoded?: Record<string, string> | null; // named fields from a registered decoder (TRACER-005)
}

export interface NfcEntry {
  id?: string;
  timestamp: string; // ISO-8601
  type: string; // scanStarted, tagDetected, recordParsed, iosTrustDecoded, scanFailed, …
  descriptor?: string | null; // MIME type or tag technology
  hex?: string | null;
  detail?: string | null;
  error?: string | null;
}

export interface WireTapSession {
  schemaVersion: number; // current: 1
  exportedAt?: string;
  app?: AppInfo;
  environment?: EnvInfo;
  range?: { start: string; end: string } | null;
  network: NetworkEntry[];
  ble: BleEntry[];
  nfc: NfcEntry[];
}

/** A single event projected onto the unified, cross-stream timeline. */
export interface TimelineItem {
  timestamp: string;
  kind: Stream;
  summary: string;
}

export const SUPPORTED_SCHEMA_MAJOR = 1;
