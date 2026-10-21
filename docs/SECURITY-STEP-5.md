# Security Step 5: Download and Bridge Hardening

Step 5 hardens browser downloads, the local WebSocket bridge, and remote-access key storage.

## Downloads

Downloads are checked against the configured website policy, including links whose destination is resolved through a page’s `<base href>`. Both extension-side and CDP downloads:

- omit the browser’s cookies and other browser credentials;
- refuse redirects, so an allowed URL cannot silently send the download to another destination;
- enforce a 50 MiB limit while streaming, even when the response does not provide a trustworthy content length.

Downloads that require the signed-in browser session may fail because the download request does not reuse browser cookies. The user can download those files directly in Chrome instead.

## Local WebSocket bridge

The bridge rejects requests that claim to come from an ordinary web page. It accepts connections without an `Origin` header for native clients and accepts Chrome extension origins. This reduces the risk of a web page using a visitor’s browser to connect to the local bridge.

Incoming frames are capped at 4 MiB, and WebSocket compression is disabled to limit memory and decompression abuse. These checks complement the bridge token and per-app command signatures; they do not protect a computer from malware already running as the local user.

## Remote access key

The remote access key is randomly generated and stored in the MCP data directory. On macOS and Linux, the server repairs its file permissions to owner-only access and refuses to continue if group or other users can read it. Rotating the key invalidates existing remote clients. Windows uses its platform file-permission model rather than this POSIX mode check.

## Limits

These controls reduce specific risks; they do not make the MCP server or browser extension impossible to exploit. Keep app and website approvals limited to what is needed, remove grants when finished, and use the extension’s Stop control if access should end immediately. The required Chrome `debugger` permission remains broad at the browser level, so the extension’s website checks are application safeguards rather than a Chrome-enforced per-site sandbox.
