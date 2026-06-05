# WireTap session — connected-device runtime trace
Schema: each timeline line is one event — `- <ts> <stream> <fields>`.
  net: method url status durMs (req/resp bodies shown on failures)
  ble: type uuid device hex(<=256B) detail err
  nfc: type descriptor hex(<=256B) detail err
Times ISO-8601 UTC. "…+N more bytes" / "…+N more chars" mark truncation. Secrets redacted.
App: com.apple.dt.xctest.tool 16.0 | OS: macOS Version 26.6 (Build 25G5028f) | Events: 5 over 1970-01-01T00:16:40.000Z → 1970-01-01T00:16:44.000Z

## timeline (ascending)
- 1970-01-01T00:16:40.000Z nfc scanCompleted "MS2-A1B2"
- 1970-01-01T00:16:41.000Z ble connected device=MS2-A1B2
- 1970-01-01T00:16:42.000Z ble notification uuid=C0DEC0DE-1003 hex=abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab …+44 more bytes {a8=2.1 status=LOW_BATTERY} "alert"
- 1970-01-01T00:16:43.000Z ble authFailed device=MS2-A1B2 ERR=stale cert
- 1970-01-01T00:16:44.000Z net POST https://api/sessions 401 120ms req={"deviceId":"MS2-A1B2"} resp={"error":"device not authenticated"}