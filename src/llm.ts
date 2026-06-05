/**
 * LLM-optimized markdown renderer — a faithful port of the Swift package's
 * TRACER-003 `LLMRenderer.markdown`. Keeping the two in lockstep is the whole point:
 * `wiretap_get_timeline` returns this output, and the golden test
 * (`test/fixtures/golden.llm.md`, emitted by Swift) pins it so the Swift and Node
 * sides cannot drift. If you change the format here, regenerate the golden from Swift.
 */

import { WireTapSession, Stream } from "./types.js";

export interface LLMOptions {
  include: Set<Stream>;
  maxPayloadBytes: number;
  maxBodyChars: number;
  maxEntriesPerStream: number;
  includeSchemaPreamble: boolean;
}

export function defaultLLMOptions(): LLMOptions {
  return {
    include: new Set<Stream>(["network", "ble", "nfc"]),
    maxPayloadBytes: 256,
    maxBodyChars: 256,
    maxEntriesPerStream: 200,
    includeSchemaPreamble: true,
  };
}

interface Ev {
  ts: string;
  kind: string; // "net" | "ble" | "nfc"
  summary: string;
}

function truncateHex(hex: string | null | undefined, maxBytes: number): string | null {
  if (!hex) return null;
  const total = Math.floor(hex.length / 2);
  if (total <= maxBytes) return hex;
  return hex.slice(0, maxBytes * 2) + ` …+${total - maxBytes} more bytes`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + ` …+${text.length - maxChars} more chars`;
}

/** A network entry is a "failure" if it errored or returned a non-2xx status. */
function isFailure(e: { error?: string | null; statusCode?: number | null }): boolean {
  if (e.error) return true;
  if (e.statusCode != null) return e.statusCode < 200 || e.statusCode >= 300;
  return false;
}

function buildEvents(s: WireTapSession, o: LLMOptions): { events: Ev[]; notes: string[] } {
  const events: Ev[] = [];
  const notes: string[] = [];
  const note = (name: string, total: number) => {
    if (total > o.maxEntriesPerStream) {
      notes.push(`${name}: showing newest ${o.maxEntriesPerStream} of ${total}`);
    }
  };

  if (o.include.has("network")) {
    note("network", s.network.length);
    for (const e of s.network.slice(-o.maxEntriesPerStream)) {
      const status = e.error ? `ERR(${e.error})` : (e.statusCode != null ? String(e.statusCode) : "?");
      let summary = `${e.method} ${e.url} ${status} ${e.durationMs ?? 0}ms`;
      // Show request/response bodies only for failures (the usual clue), truncated.
      if (isFailure(e)) {
        if (e.requestBody) summary += ` req=${truncateText(e.requestBody, o.maxBodyChars)}`;
        if (e.responseBody) summary += ` resp=${truncateText(e.responseBody, o.maxBodyChars)}`;
      }
      events.push({ ts: e.timestamp, kind: "net", summary });
    }
  }
  if (o.include.has("ble")) {
    note("ble", s.ble.length);
    for (const e of s.ble.slice(-o.maxEntriesPerStream)) {
      const parts = [e.type];
      if (e.uuid) parts.push(`uuid=${e.uuid}`);
      if (e.device) parts.push(`device=${e.device}`);
      const h = truncateHex(e.hex, o.maxPayloadBytes);
      if (h) parts.push(`hex=${h}`);
      if (e.decoded && Object.keys(e.decoded).length) {
        const fields = Object.keys(e.decoded)
          .sort()
          .map((k) => `${k}=${e.decoded![k]}`)
          .join(" ");
        parts.push(`{${fields}}`);
      }
      if (e.detail) parts.push(`"${e.detail}"`);
      if (e.error) parts.push(`ERR=${e.error}`);
      events.push({ ts: e.timestamp, kind: "ble", summary: parts.join(" ") });
    }
  }
  if (o.include.has("nfc")) {
    note("nfc", s.nfc.length);
    for (const e of s.nfc.slice(-o.maxEntriesPerStream)) {
      const parts = [e.type];
      if (e.descriptor) parts.push(`desc=${e.descriptor}`);
      const h = truncateHex(e.hex, o.maxPayloadBytes);
      if (h) parts.push(`hex=${h}`);
      if (e.detail) parts.push(`"${e.detail}"`);
      if (e.error) parts.push(`ERR=${e.error}`);
      events.push({ ts: e.timestamp, kind: "nfc", summary: parts.join(" ") });
    }
  }

  events.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return { events, notes };
}

/** Render a session as LLM-ingestible markdown — byte-identical to Swift TRACER-003. */
export function renderLLMMarkdown(s: WireTapSession, o: LLMOptions = defaultLLMOptions()): string {
  const lines: string[] = ["# WireTap session — connected-device runtime trace"];

  if (o.includeSchemaPreamble) {
    lines.push(
      "Schema: each timeline line is one event — `- <ts> <stream> <fields>`.\n" +
        "  net: method url status durMs (req/resp bodies shown on failures)\n" +
        `  ble: type uuid device hex(<=${o.maxPayloadBytes}B) detail err\n` +
        `  nfc: type descriptor hex(<=${o.maxPayloadBytes}B) detail err\n` +
        'Times ISO-8601 UTC. "…+N more bytes" / "…+N more chars" mark truncation. Secrets redacted.'
    );
  }

  const total = s.network.length + s.ble.length + s.nfc.length;
  const range = s.range ? `${s.range.start} → ${s.range.end}` : "no events";
  const app = s.app ?? {};
  const env = s.environment ?? {};
  lines.push(
    `App: ${app.bundleId ?? "unknown"} ${app.version ?? "0"} | OS: ${env.os ?? ""} ${env.osVersion ?? ""} | Events: ${total} over ${range}`
  );

  const { events, notes } = buildEvents(s, o);
  lines.push("");
  lines.push("## timeline (ascending)");
  for (const n of notes) lines.push(`(${n})`);
  if (events.length === 0) {
    lines.push("(no events captured)");
  } else {
    for (const e of events) lines.push(`- ${e.ts} ${e.kind} ${e.summary}`);
  }

  return lines.join("\n");
}
