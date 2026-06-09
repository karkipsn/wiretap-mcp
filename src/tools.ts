/**
 * Tool logic, as pure async functions returning plain text. `index.ts` registers
 * thin MCP wrappers around these; the test suite calls them directly.
 *
 * `getTimeline` returns the shared `renderLLMMarkdown` output verbatim (TRACER-004
 * AC-2) so it can never drift from the Swift TRACER-003 renderer.
 */

import path from "node:path";
import { Stream } from "./types.js";
import { loadSession, findSessionFiles, getDefaultSource, SessionError, getLiveBridgeUrl } from "./session.js";
import { isBridgeAlive } from "./bridge.js";
import { summarizeNetwork, summarizeBle, summarizeNfc, detailNetwork } from "./format.js";
import { renderLLMMarkdown, defaultLLMOptions } from "./llm.js";

/** Every tool this server exposes. Read-only by construction (TRACER-004 AC-7). */
export const TOOL_NAMES = [
  "wiretap_list_sessions",
  "wiretap_get_overview",
  "wiretap_get_timeline",
  "wiretap_query_ble",
  "wiretap_get_network_failures",
  "wiretap_get_nfc_records",
  "wiretap_search",
] as const;

function sessionHeader(file: string, s: any): string {
  const app = s.app ? `${s.app.name ?? s.app.bundleId ?? "app"} ${s.app.version ?? ""}`.trim() : "unknown app";
  const env = s.environment ? `${s.environment.os ?? ""} ${s.environment.osVersion ?? ""}`.trim() : "";
  const counts = `network=${s.network.length} ble=${s.ble.length} nfc=${s.nfc.length}`;
  const range = s.range ? `${s.range.start} → ${s.range.end}` : "no events";
  return `# ${path.basename(file)}\napp: ${app}${env ? ` | ${env}` : ""}\nevents: ${counts} | range: ${range}`;
}

/** Run a body against a loaded session, turning SessionErrors into graceful text. */
async function withSession(sessionPath: string | undefined, body: (loaded: Awaited<ReturnType<typeof loadSession>>) => Promise<string> | string): Promise<string> {
  try {
    return await body(await loadSession(sessionPath));
  } catch (e: any) {
    if (e instanceof SessionError) return e.message;
    return `Unexpected error: ${e?.message ?? String(e)}`;
  }
}

export async function listSessions(dir?: string): Promise<string> {
  // Live mode: show bridge status instead of a directory listing.
  const liveUrl = getLiveBridgeUrl();
  if (!dir && liveUrl) {
    const alive = await isBridgeAlive(liveUrl);
    if (alive) {
      const { session, file } = await loadSession();
      return `Live bridge: ${liveUrl} (reachable)\n${sessionHeader(file, session)}`;
    }
    return `Live bridge: ${liveUrl} (unreachable — is the app running with WireTap.startLocalBridge()?)`;
  }

  const target = dir ? path.resolve(dir) : getDefaultSource();
  const files = await findSessionFiles(target);
  if (files.length === 0) {
    try {
      const loaded = await loadSession(dir);
      return sessionHeader(loaded.file, loaded.session);
    } catch {
      return `No .wiretapsession files found under: ${target}`;
    }
  }
  const lines = await Promise.all(
    files.map(async (f) => {
      try {
        const { session } = await loadSession(f);
        return `- ${f} (network=${session.network.length} ble=${session.ble.length} nfc=${session.nfc.length})`;
      } catch {
        return `- ${f} (unreadable)`;
      }
    })
  );
  return `Sessions under ${target}:\n${lines.join("\n")}`;
}

export function getOverview(session?: string): Promise<string> {
  return withSession(session, ({ file, session: s }) => {
    const netFails = s.network.filter((e) => e.error || (e.statusCode != null && (e.statusCode < 200 || e.statusCode >= 300)));
    const bleErrors = s.ble.filter((e) => e.error || /fail|error/i.test(e.type));
    const nfcErrors = s.nfc.filter((e) => e.error || /fail/i.test(e.type));

    const out: string[] = [sessionHeader(file, s), ""];
    out.push(`errors: network=${netFails.length} ble=${bleErrors.length} nfc=${nfcErrors.length}`);
    if (netFails.length) {
      out.push("\nnetwork failures:");
      netFails.slice(0, 10).forEach((e) => out.push(`  ${summarizeNetwork(e)}`));
    }
    if (bleErrors.length) {
      out.push("\nble errors:");
      bleErrors.slice(0, 10).forEach((e) => out.push(`  ${summarizeBle(e)}`));
    }
    if (nfcErrors.length) {
      out.push("\nnfc errors:");
      nfcErrors.slice(0, 10).forEach((e) => out.push(`  ${summarizeNfc(e)}`));
    }
    return out.join("\n");
  });
}

export function getTimeline(args: { session?: string; kinds?: Stream[]; limit?: number }): Promise<string> {
  return withSession(args.session, ({ session: s }) => {
    const opts = defaultLLMOptions();
    if (args.kinds && args.kinds.length) opts.include = new Set(args.kinds);
    if (args.limit) opts.maxEntriesPerStream = args.limit;
    // AC-2: return the shared renderer output verbatim — no extra wrapping.
    return renderLLMMarkdown(s, opts);
  });
}

export function queryBle(args: { session?: string; type?: string; uuid?: string; device?: string; limit?: number }): Promise<string> {
  return withSession(args.session, ({ file, session: s }) => {
    let rows = s.ble;
    if (args.type) rows = rows.filter((e) => e.type.toLowerCase() === args.type!.toLowerCase());
    if (args.uuid) rows = rows.filter((e) => (e.uuid ?? "").toLowerCase().includes(args.uuid!.toLowerCase()));
    if (args.device) rows = rows.filter((e) => (e.device ?? "").toLowerCase().includes(args.device!.toLowerCase()));
    const cap = args.limit ?? 100;
    const shown = rows.slice(0, cap);
    const note = rows.length > cap ? ` (showing ${cap} of ${rows.length})` : "";
    const body = shown.map((e) => `${e.timestamp}  ${summarizeBle(e)}`).join("\n");
    return `${sessionHeader(file, s)}\n\n## ble matches${note}\n${body || "(no matches)"}`;
  });
}

export function getNetworkFailures(args: { session?: string; limit?: number }): Promise<string> {
  return withSession(args.session, ({ file, session: s }) => {
    const fails = s.network.filter((e) => e.error || (e.statusCode != null && (e.statusCode < 200 || e.statusCode >= 300)));
    const cap = args.limit ?? 20;
    const shown = fails.slice(0, cap);
    const note = fails.length > cap ? ` (showing ${cap} of ${fails.length})` : "";
    const body = shown.map((e) => detailNetwork(e)).join("\n\n---\n");
    return `${sessionHeader(file, s)}\n\n## network failures${note}\n${body || "(none — all requests succeeded)"}`;
  });
}

export function getNfcRecords(session?: string): Promise<string> {
  return withSession(session, ({ file, session: s }) => {
    const body = s.nfc.map((e) => `${e.timestamp}  ${summarizeNfc(e)}`).join("\n");
    return `${sessionHeader(file, s)}\n\n## nfc events\n${body || "(no nfc events)"}`;
  });
}

export function search(args: { session?: string; query: string; limit?: number }): Promise<string> {
  return withSession(args.session, ({ file, session: s }) => {
    const q = args.query.toLowerCase();
    const hits: string[] = [];
    const push = (ts: string, line: string) => {
      if (line.toLowerCase().includes(q)) hits.push(`${ts}  ${line}`);
    };
    s.network.forEach((e) => push(e.timestamp, summarizeNetwork(e)));
    s.ble.forEach((e) => push(e.timestamp, summarizeBle(e)));
    s.nfc.forEach((e) => push(e.timestamp, summarizeNfc(e)));
    hits.sort();
    const cap = args.limit ?? 50;
    const shown = hits.slice(0, cap);
    const note = hits.length > cap ? ` (showing ${cap} of ${hits.length})` : "";
    return `${sessionHeader(file, s)}\n\n## search "${args.query}"${note}\n${shown.join("\n") || "(no matches)"}`;
  });
}
