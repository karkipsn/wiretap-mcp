/**
 * Live bridge client — fetches a WireTapSession from a running app's local HTTP bridge
 * (started by `WireTap.startLocalBridge()` on the Swift side, TRACER-004 live mode).
 *
 * Usage: set WIRETAP_BRIDGE_URL=http://127.0.0.1:8787 when launching the MCP server,
 * or pass --live [port] on the command line. When active, tool calls that do not
 * specify an explicit session path will fetch live data from the running app.
 */

import { WireTapSession } from "./types.js";

const CONNECT_TIMEOUT_MS = 3_000;

export class BridgeError extends Error {}

/**
 * Fetch the current session from the running app's local bridge.
 * Throws BridgeError with a helpful message when the app is not reachable.
 */
export async function fetchLiveSession(baseUrl: string): Promise<WireTapSession> {
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/session`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new BridgeError(
      `WireTap bridge unreachable at ${baseUrl}: ${e?.message ?? e}. ` +
      `Is the app running with WireTap.startLocalBridge()?`
    );
  }
  if (!resp.ok) {
    throw new BridgeError(`Bridge returned HTTP ${resp.status} for /session`);
  }
  return resp.json() as Promise<WireTapSession>;
}

/** Returns true if the bridge is up and responding. */
export async function isBridgeAlive(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/session`, {
      signal: AbortSignal.timeout(1_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Build a bridge base URL from a port number. */
export function bridgeUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
