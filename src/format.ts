/**
 * Rendering entries to compact, deterministic, LLM-friendly text.
 *
 * This mirrors the Swift package's TRACER-003 "LLM-Optimized Export" so the agent
 * sees a stable, token-efficient view. Large payloads are truncated with an explicit
 * `…+N more bytes` marker; nothing is silently dropped.
 */

import { NetworkEntry, BleEntry, NfcEntry } from "./types.js";

const DEFAULT_MAX_HEX_BYTES = 32;

/** Truncate a hex string to `maxBytes`, appending a marker if shortened. */
export function truncateHex(hex: string | null | undefined, maxBytes = DEFAULT_MAX_HEX_BYTES): string {
  if (!hex) return "";
  const totalBytes = Math.floor(hex.length / 2);
  if (totalBytes <= maxBytes) return spaceHex(hex);
  const shown = hex.slice(0, maxBytes * 2);
  return `${spaceHex(shown)} …+${totalBytes - maxBytes} more bytes`;
}

function spaceHex(hex: string): string {
  return (hex.match(/.{1,2}/g) ?? []).join(" ");
}

function t(ts: string): string {
  // keep the time portion compact but unambiguous
  return ts || "?";
}

export function summarizeNetwork(e: NetworkEntry): string {
  const status = e.error ? `ERR(${e.error})` : e.statusCode ?? "?";
  const dur = e.durationMs != null ? ` ${e.durationMs}ms` : "";
  return `net ${e.method} ${e.url} ${status}${dur}`;
}

export function summarizeBle(e: BleEntry): string {
  const parts = [`ble ${e.type}`];
  if (e.uuid) parts.push(`uuid=${e.uuid}`);
  if (e.device) parts.push(`device=${e.device}`);
  if (e.hex) parts.push(`hex=${truncateHex(e.hex)}`);
  // decoded named fields (TRACER-005), same `{k=v}` shape as the llm.ts renderer
  if (e.decoded && Object.keys(e.decoded).length) {
    const fields = Object.keys(e.decoded)
      .sort()
      .map((k) => `${k}=${e.decoded![k]}`)
      .join(" ");
    parts.push(`{${fields}}`);
  }
  if (e.detail) parts.push(`"${e.detail}"`);
  if (e.error) parts.push(`ERR=${e.error}`);
  return parts.join(" ");
}

export function summarizeNfc(e: NfcEntry): string {
  const parts = [`nfc ${e.type}`];
  if (e.descriptor) parts.push(`desc=${e.descriptor}`);
  if (e.hex) parts.push(`hex=${truncateHex(e.hex)}`);
  if (e.detail) parts.push(`"${e.detail}"`);
  if (e.error) parts.push(`ERR=${e.error}`);
  return parts.join(" ");
}

export const summarizers = {
  network: summarizeNetwork,
  ble: summarizeBle,
  nfc: summarizeNfc,
};

/** A full request/response detail block for a single network entry. */
export function detailNetwork(e: NetworkEntry): string {
  const lines: string[] = [];
  lines.push(`${e.method} ${e.url}`);
  lines.push(`time: ${t(e.timestamp)}  status: ${e.error ? `ERROR(${e.error})` : e.statusCode}  duration: ${e.durationMs ?? "?"}ms`);
  if (e.requestHeaders && Object.keys(e.requestHeaders).length) {
    lines.push("request headers:");
    for (const [k, v] of Object.entries(e.requestHeaders)) lines.push(`  ${k}: ${v}`);
  }
  if (e.requestBody) lines.push(`request body: ${e.requestBody}`);
  if (e.responseBody) lines.push(`response body: ${truncate(e.responseBody, 1000)}`);
  lines.push(`curl: ${curl(e)}`);
  return lines.join("\n");
}

function curl(e: NetworkEntry): string {
  const headerArgs = Object.entries(e.requestHeaders ?? {})
    .map(([k, v]) => `-H '${k}: ${v}'`)
    .join(" ");
  const body = e.requestBody ? ` --data '${e.requestBody}'` : "";
  return `curl -X ${e.method} ${headerArgs} '${e.url}'${body}`.replace(/\s+/g, " ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)} …+${s.length - n} more chars`;
}
