# wiretap-mcp

An **MCP server** that feeds a connected-device app's captured **BLE, NFC, and HTTP
traffic** to AI coding agents (Claude Code, Cursor, VS Code, Windsurf).

Existing debug-tool MCP servers (Jam, Chrome DevTools, Fiddler) are **network-only**.
When a BLE/NFC app misbehaves, the agent is blind to the radio layer. `wiretap-mcp`
fixes that: point it at a captured session and the agent can read the real
`NFC tap → BLE connect → pair → auth → disconnect → HTTP 401` timeline and reason
about the actual failure.

It is **read-only** — it inspects session files; it cannot modify or replay traffic.

---

## Status & maturity

Be clear-eyed about what exists today:

| Piece | Status |
|-------|--------|
| **File mode** (read an exported `.wiretapsession`) | ✅ Built. Manually verified via the stdio handshake + `tools/list` + `tools/call`, and cross-validated against a real file emitted by the Swift `WireTap` package. |
| The 7 tools below | ✅ Built; covered by the test suite + the smoke test. |
| **Automated test suite** | ✅ `npm test` runs the TRACER-004 ACs (`test/server.test.ts`). Includes a golden cross-language test pinning the timeline to the Swift renderer. |
| **Live mode** (query a running app over a localhost bridge) | ◻️ Not built. File mode only for now. |
| MCP **resources** (`wiretap://…`) and canned **prompts** | ◻️ Not built — tools only. |
| Verified *inside* each named agent (Claude Code, Cursor, …) | ◻️ Not individually. It speaks standard MCP stdio, so any MCP-capable client should work, but I've confirmed the protocol, not each app. |

**Who can produce sessions today:** only the **Swift `WireTap` package** emits `.wiretapsession`
files (see TRACER-002/003). React Native / Flutter *can* feed this server, but **no exporter
or bridge ships for them yet** — you'd serialize to the [contract](#the-session-contract)
yourself. The server is deliberately producer-agnostic; that just means the producer is your
responsibility outside Swift.

---

## How it fits the bigger picture

```
Your app                           wiretap-mcp (this)            AI agent
────────                           ─────────────────            ────────
Swift WireTap pkg  ✅ today  ┐                                   any MCP client
React Native     (DIY export)├─►  .wiretapsession (JSON)  ──►   (Claude Code,
Flutter / native (DIY export)┘     reads (read-only)            Cursor, VS Code…)
```

The server depends only on the **`.wiretapsession` JSON contract** (see
[`src/types.ts`](src/types.ts)), not on Swift — so it's producer-agnostic. **Today the
only shipped producer is the Swift `WireTap` package.** A hybrid app can feed it too, but
you'd write the serialization to the contract yourself (no bridge is provided yet).

---

## Requirements

- Node.js 18+
- An MCP-capable agent (Claude Code, Cursor, VS Code Agent mode, Windsurf)

## Build

```bash
cd LocalPackages/wiretap-mcp
npm install
npm run build      # → dist/
```

## Try it without an agent (MCP Inspector)

The Inspector is a UI that calls your tools directly — the fastest way to learn and debug:

```bash
npm run inspector   # launches the Inspector against the bundled MS2 sample
```

## Quick smoke test (no UI)

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| node dist/index.js examples/ms2-pairing-failure.wiretapsession
```

---

## Connect it to an agent

The server is launched by the agent over **stdio**. You give it a default session
source as the first argument (a `.wiretapsession` file or a directory of them).

### Claude Code

```bash
claude mcp add wiretap -- node /abs/path/to/LocalPackages/wiretap-mcp/dist/index.js /abs/path/to/sessions
```

…or edit `~/.claude.json` / project `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "wiretap": {
      "command": "node",
      "args": [
        "/abs/path/to/LocalPackages/wiretap-mcp/dist/index.js",
        "/abs/path/to/sessions"   // a dir (newest session is used) or a single file
      ]
    }
  }
}
```

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "wiretap": {
      "command": "node",
      "args": ["/abs/path/to/dist/index.js", "/abs/path/to/sessions"]
    }
  }
}
```

The session source can also be set via env instead of an arg:
`WIRETAP_SESSION=/path/to/file.wiretapsession` or `WIRETAP_SESSIONS_DIR=/path/to/dir`.

Then just ask the agent: *"Use the wiretap tools — why did the last pairing fail?"*

---

## Tools

| Tool | Purpose |
|------|---------|
| `wiretap_list_sessions` | List available session files (newest first). |
| `wiretap_get_overview` | Counts, error counts, time range, notable failures. **Start here.** |
| `wiretap_get_timeline` | Unified BLE+NFC+network timeline, time-ordered. `kinds`, `limit`. |
| `wiretap_query_ble` | Filter BLE by `type` / `uuid` / `device`. |
| `wiretap_get_network_failures` | Non-2xx / errored requests with cURL + response. |
| `wiretap_get_nfc_records` | All NFC events (scan, tag, NDEF, decode). |
| `wiretap_search` | Full-text search across every event. |

Every tool takes an optional `session` path to override the default source, and
caps its output so it never floods the agent's context.

---

## The session contract

Minimal example (full schema in [`src/types.ts`](src/types.ts), reference fixture in
[`examples/`](examples/)):

```json
{
  "schemaVersion": 1,
  "app": { "name": "MyApp", "version": "1.0.0" },
  "environment": { "os": "iOS", "osVersion": "17.4" },
  "range": { "start": "...", "end": "..." },
  "network": [ { "timestamp": "...", "method": "POST", "url": "...", "statusCode": 401 } ],
  "ble":     [ { "timestamp": "...", "type": "authFailed", "device": "MS2-A1B2", "error": "..." } ],
  "nfc":     [ { "timestamp": "...", "type": "recordParsed", "descriptor": "application/vnd.ms2.ios-trust" } ]
}
```

- Timestamps are ISO-8601.
- BLE/NFC payloads use a `hex` string. (`dataHex` or base64 `data` are also accepted
  and normalized to hex.)
- **Redaction is the producer's job** — never write secrets into the file. This
  server trusts that the export is already redacted and never de-redacts.

To produce these files from the Swift `WireTap` package, see TRACER-002 / TRACER-003
in `../WireTap/doc/specs/`.

---

## Development

```bash
npm run dev          # run from TypeScript source (tsx), no build step
npm run typecheck    # tsc --noEmit
npm run build        # compile to dist/
npm test             # TRACER-004 acceptance tests (node:test via tsx)
```

## Roadmap (aligned with `../WireTap/doc/specs/TRACER-004`)

- ✅ **File mode** — read exported sessions. *(done)*
- ✅ **Automated tests** — TRACER-004 ACs in `test/server.test.ts`. *(done)*
- ◻️ **Live mode** — an opt-in localhost read-only HTTP bridge in the app so the agent queries
  traffic *as it happens*, not just from a file. *(not started)*
- ◻️ **MCP resources** (`wiretap://session/current`) and canned **prompts** (`diagnose-disconnect`).
  *(not started)*
- ◻️ **Hybrid exporters** — a shared serializer / native bridge so RN & Flutter can emit
  `.wiretapsession` without hand-rolling it. *(not started)*

**Anti-drift guarantee:** `wiretap_get_timeline` is rendered by `src/llm.ts`, a faithful port of
the Swift package's TRACER-003 `LLMRenderer`. The test `AC-2` asserts its output is
byte-identical to `test/fixtures/golden.llm.md` — a golden file emitted *by Swift*. If the two
ever diverge, the test fails. Regenerate the golden from Swift when the format intentionally changes.

## License

**Proprietary — source-available, not open source.** Copyright © 2026 Poshan Karki.
All rights reserved. The source is published for reference and evaluation only; no
permission is granted to use, copy, modify, or redistribute it without prior written
consent. See [LICENSE](LICENSE).

> The companion **WireTap** Swift package (which produces the `.wiretapsession` files this
> server reads) is separately released under the MIT license. The `.wiretapsession` format
> itself is open, so you are free to build your own tooling against it.
