#!/usr/bin/env node
/**
 * wiretap-mcp — an MCP server that feeds a connected-device app's captured
 * BLE / NFC / HTTP traffic (a WireTap session) to AI coding agents.
 *
 * MENTAL MODEL (for anyone new to MCP):
 *   - An MCP server exposes "tools" = functions an AI agent (Claude Code, Cursor,
 *     VS Code, Windsurf) can call.
 *   - The agent's host launches this process and talks to it over STDIN/STDOUT
 *     ("stdio transport"). NEVER print to stdout yourself — that's the protocol
 *     channel. Use stderr (console.error) for logging.
 *
 * This file is intentionally thin: every tool's logic lives in `tools.ts` (so it's
 * unit-testable); here we just declare schemas and forward calls. Read-only.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getDefaultSource, loadSession, findSessionFiles, configureLiveBridge, getLiveBridgeUrl } from "./session.js";
import { renderLLMMarkdown, defaultLLMOptions } from "./llm.js";
import { bridgeUrl, isBridgeAlive } from "./bridge.js";
import * as tools from "./tools.js";

type TextResult = { content: { type: "text"; text: string }[] };
const text = (s: string): TextResult => ({ content: [{ type: "text", text: s }] });

const server = new McpServer({ name: "wiretap-mcp", version: "0.1.0" });

const sessionArg = {
  session: z.string().optional().describe("Path to a .wiretapsession file or directory. Defaults to the server's configured source."),
};

// Every tool is read-only: it inspects a session file and never mutates state.
const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

server.registerTool(
  "wiretap_list_sessions",
  {
    description: "List WireTap session files available to inspect, newest first.",
    inputSchema: { dir: z.string().optional().describe("Directory to scan. Defaults to the configured source.") },
    annotations: readOnly,
  },
  async ({ dir }) => text(await tools.listSessions(dir))
);

server.registerTool(
  "wiretap_get_overview",
  {
    description: "Summarize a session: counts per stream, error counts, time range, notable failures. Start here.",
    inputSchema: { ...sessionArg },
    annotations: readOnly,
  },
  async ({ session }) => text(await tools.getOverview(session))
);

server.registerTool(
  "wiretap_get_timeline",
  {
    description: "The unified, time-ordered timeline merging BLE, NFC and network events. Best view for 'what happened, in order'.",
    inputSchema: {
      ...sessionArg,
      kinds: z.array(z.enum(["network", "ble", "nfc"])).optional().describe("Restrict to these streams. Default: all."),
      limit: z.number().int().positive().optional().describe("Max events per stream (newest kept). Default 200."),
    },
    annotations: readOnly,
  },
  async ({ session, kinds, limit }) => text(await tools.getTimeline({ session, kinds, limit }))
);

server.registerTool(
  "wiretap_query_ble",
  {
    description: "Filter BLE events by type / characteristic UUID / device name. Use to investigate connection, pairing and auth flows.",
    inputSchema: {
      ...sessionArg,
      type: z.string().optional().describe("BLE event type, e.g. 'disconnected', 'authFailed', 'notification'."),
      uuid: z.string().optional().describe("Match a service/characteristic UUID (substring, case-insensitive)."),
      device: z.string().optional().describe("Match a peripheral name (substring)."),
      limit: z.number().int().positive().optional().describe("Max events. Default 100."),
    },
    annotations: readOnly,
  },
  async ({ session, type, uuid, device, limit }) => text(await tools.queryBle({ session, type, uuid, device, limit }))
);

server.registerTool(
  "wiretap_get_network_failures",
  {
    description: "All non-2xx or errored HTTP requests, each with a reconstructed cURL and response excerpt.",
    inputSchema: { ...sessionArg, limit: z.number().int().positive().optional().describe("Max requests. Default 20.") },
    annotations: readOnly,
  },
  async ({ session, limit }) => text(await tools.getNetworkFailures({ session, limit }))
);

server.registerTool(
  "wiretap_get_nfc_records",
  {
    description: "All NFC events (scan, tag detection, parsed NDEF records, decode results) in order.",
    inputSchema: { ...sessionArg },
    annotations: readOnly,
  },
  async ({ session }) => text(await tools.getNfcRecords(session))
);

server.registerTool(
  "wiretap_search",
  {
    description: "Full-text search across all events (url, uuid, device, descriptor, detail, error).",
    inputSchema: {
      ...sessionArg,
      query: z.string().describe("Case-insensitive substring to find."),
      limit: z.number().int().positive().optional().describe("Max matches. Default 50."),
    },
    annotations: readOnly,
  },
  async ({ session, query, limit }) => text(await tools.search({ session, query, limit }))
);

// ── Resources ──────────────────────────────────────────────────────────────
// wiretap://session/current  — the most recent session as raw JSON
// wiretap://session/{id}     — a session file by path (URL-encoded)

server.registerResource(
  "current-session",
  "wiretap://session/current",
  {
    description: "The most recent WireTap session as a .wiretapsession JSON document.",
    mimeType: "application/json",
  },
  async (_uri) => {
    try {
      const { session } = await loadSession(undefined);
      return { contents: [{ uri: "wiretap://session/current", text: JSON.stringify(session, null, 2), mimeType: "application/json" }] };
    } catch (e: any) {
      return { contents: [{ uri: "wiretap://session/current", text: `No session available: ${e.message}` }] };
    }
  }
);

server.registerResource(
  "session-by-path",
  new ResourceTemplate("wiretap://session/{path}", { list: async () => {
    const files = await findSessionFiles(getDefaultSource());
    return {
      resources: files.map((f) => ({
        uri: `wiretap://session/${encodeURIComponent(f)}`,
        name: f.split("/").pop() ?? f,
        mimeType: "application/json",
      })),
    };
  }}),
  {
    description: "A specific WireTap session file, identified by its URL-encoded file path.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const filePath = decodeURIComponent(variables.path as string);
    try {
      const { session } = await loadSession(filePath);
      return { contents: [{ uri: uri.href, text: JSON.stringify(session, null, 2), mimeType: "application/json" }] };
    } catch (e: any) {
      return { contents: [{ uri: uri.href, text: `Could not load session: ${e.message}` }] };
    }
  }
);

// ── Prompts ─────────────────────────────────────────────────────────────────

server.registerPrompt(
  "diagnose-disconnect",
  {
    description: "Pre-fills the BLE connection lifecycle and asks the agent to find the disconnect root cause.",
    argsSchema: {
      session: z.string().optional().describe("Path to a .wiretapsession file. Defaults to the configured source."),
    },
  },
  async ({ session }) => {
    const timeline = await tools.getTimeline({ session, kinds: ["ble"] });
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Here is the BLE event timeline from a WireTap session:\n\n${timeline}\n\nPlease analyse this BLE lifecycle, identify why the device disconnected or failed to pair, and suggest what the app code should fix.`,
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  "explain-network-failures",
  {
    description: "Pre-fills all failed HTTP requests and asks the agent to triage them.",
    argsSchema: {
      session: z.string().optional().describe("Path to a .wiretapsession file. Defaults to the configured source."),
    },
  },
  async ({ session }) => {
    const failures = await tools.getNetworkFailures({ session });
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Here are the failed HTTP requests captured by WireTap:\n\n${failures}\n\nPlease triage these failures: identify the root cause of each, explain what likely went wrong, and suggest fixes.`,
          },
        },
      ],
    };
  }
);

// ── Live bridge setup ────────────────────────────────────────────────────────
// Enabled by: --live [port]  |  WIRETAP_BRIDGE_URL=http://127.0.0.1:8787
//                            |  WIRETAP_BRIDGE_PORT=8787

function resolveLiveBridgeUrl(): string | null {
  // CLI: --live [optional-port]
  const liveIdx = process.argv.indexOf("--live");
  if (liveIdx !== -1) {
    const maybePort = process.argv[liveIdx + 1];
    const port = maybePort && /^\d+$/.test(maybePort) ? Number(maybePort) : 8787;
    return bridgeUrl(port);
  }
  // Env: full URL
  if (process.env.WIRETAP_BRIDGE_URL) return process.env.WIRETAP_BRIDGE_URL;
  // Env: port only
  if (process.env.WIRETAP_BRIDGE_PORT) return bridgeUrl(Number(process.env.WIRETAP_BRIDGE_PORT));
  return null;
}

async function main() {
  const liveUrl = resolveLiveBridgeUrl();
  if (liveUrl) {
    configureLiveBridge(liveUrl);
    const alive = await isBridgeAlive(liveUrl);
    if (alive) {
      console.error(`wiretap-mcp: live mode — bridge at ${liveUrl} is reachable`);
    } else {
      console.error(`wiretap-mcp: live mode — bridge at ${liveUrl} is NOT reachable yet (will retry on each tool call)`);
    }
  } else {
    console.error(`wiretap-mcp: file mode — session source = ${getDefaultSource()}`);
  }
  await server.connect(new StdioServerTransport());
  console.error("wiretap-mcp: connected over stdio, waiting for tool calls.");
}

main().catch((e) => {
  console.error("wiretap-mcp fatal:", e);
  process.exit(1);
});
