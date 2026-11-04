# Phone pairing, version 1

The extension popup has **Phone access > Pair phone**. Generate a QR code,
scan it with the mobile client, compare the six-digit confirmation
number, and click **Allow this phone**. **Remove access** disconnects that
phone. The mobile application is implemented in the sibling
`mcp-browser-extension-mobile` project. Real phone acceptance testing is in
progress; see [MOBILE-APP-PLAN.md](MOBILE-APP-PLAN.md).

This first version uses the owner's existing remote relay and one connected
computer. It does not register additional users or provision a shared service.
The local remote server must be updated and running with an HTTPS relay or
tunnel. Chrome and the computer must remain running. The existing website
permissions and Stop access control still apply.

## QR payload

The QR encodes JSON, not a browser URL:

```json
{
  "type": "mbe-pairing",
  "v": 1,
  "url": "https://relay.example/remote/pair",
  "code": "<single-use invitation>",
  "expiresAt": 1793318520000
}
```

The invitation lasts two minutes. A new QR, cancellation, expiry or relay
disconnection invalidates it. It contains no owner connector key or permanent
phone credential. QR creation and approval are available only through the
extension's own UI and its private native messaging helper.

## Mobile client contract

1. Validate the payload type, version, expiry and HTTPS URL. Present the service
   address to the person and use a configured list of trusted service origins.
   Do not silently follow redirects to another origin or log QR contents.
2. POST JSON `{ "code": "...", "name": "My phone" }` to `<url>/claim`.
   A successful response is HTTP 202 with `state: "pending"`, `id`, `token`,
   `confirmation` and `expiresAt`. The name must be nonempty, at most 80
   characters, with no control or directional formatting characters.
3. Store the token in the platform's secure credential storage. Show the
   confirmation number and ask the person to compare it in Chrome. The phone
   name alone is not proof of identity. Scanning does not approve access.
4. Poll POST `<url>/status` every two seconds with
   `Authorization: Bearer <token>` and `Content-Type: application/json`.
   The response remains `pending` until the desktop approval. When `paired`, it
   includes `mcpUrl` and the access expiry. HTTP 404 means the request expired,
   was denied, or its access was removed; discard the credential and pair again.
5. Connect to `mcpUrl` using MCP Streamable HTTP and the same Bearer header.
   Keep the token out of URLs, analytics, crash reports and logs. Native clients
   do not send an Origin header; pairing endpoints reject web-origin requests.

Pairing errors use HTTP 400 and a generic message. There is no public approval
endpoint. A consumed invitation cannot be retried; a failed claim response
requires a new QR. The ordinary phone camera alone cannot complete this flow.

## Scope and removal

Each phone receives a separate random credential, a stable signing identity,
and a task workspace pinned to the browser profile that displayed the QR.
Profile switching and other task workspaces are unavailable to phones,
including through batch calls. Access lasts 30 days, with at most ten phones.
Allowed websites and enabled capabilities are inherited from the browser's
existing policy; pairing does not grant new websites or Chrome permissions.

Removal revokes the browser grant first, invalidates the credential and closes
that phone's MCP sessions. An action already executing may finish. Stop access
revokes browser grants for all apps and phones. After resuming, remove and pair
phones again. Rotating the owner remote key also removes saved phones.

Credentials are stored as SHA-256 hashes on the computer; signing keys are
stored in owner-only files under the data directory's `phone-pairing` folder.
The relay forwards traffic and remains a trusted transport. TLS protects each
network hop; this protocol does not provide end-to-end encryption through the
relay. The native control listener is separate from the public MCP listener,
binds only to loopback, and requires its own local secret.

## Personal browser chat

When the Mac helper explicitly enables `MBE_PHONE_CHAT=1` (or the older `MBE_PHONE_CODEX=1`), POST `<pair-url>/chat` with the same phone Bearer credential, JSON content type and no Origin. Approved phones only: pending requests, owner keys and web-origin requests are rejected. The existing relay forwards the endpoint without a deployment change. Each conversation uses one assistant: `codex` (local Codex ChatGPT sign-in) or `claude` (local Claude Code sign-in through the Claude Agent SDK). Snapshots report `agent` and the available `agents`; send `{"action":"reset","agent":"claude"}` to start a new conversation with the other assistant. Both receive only the phone's browser tools. Claude is offered only when the optional `@anthropic-ai/claude-agent-sdk` package is installed next to the helper; it bundles Claude Code and is not installed by default. A send may include `"speed":"fast"` or `"smart"` (snapshots list `speeds`); a status with `"warm":true` starts the assistant before the first message.

Actions are `status`, `send`, `stop` and `reset`. Send includes a client-generated `requestId` (8–80 alphanumeric, underscore or hyphen characters) and `text` (1–8,000 characters after trimming). Repeating a request ID returns the current conversation rather than submitting again. One turn per phone may run at a time; conflicting requests return 409.

Responses contain `state` (`ready`, `working`, `stopped`, `error`), `messages` (`id`, `role`, `text`), `activity`, a numeric `version` and an optional friendly `error`. A status request may include `since` (the last version) and `waitMs` (capped at 15,000). If nothing has changed, the request waits until text, activity or state changes, or the deadline expires. Cancellation and revocation release pending waits. The phone issues one waiting request at a time while chat is visible, uses slower checks while a request continues during browsing, and cancels network work in the background. Older helpers without `version` retain one-second working/five-second idle polling. A missing or revoked credential returns 404; disabled chat returns 409. Responses are no-store.

The local Codex process owns authentication and model inference. Browser calls are routed through an in-memory MCP connection with the same paired phone identity and current policy. Each phone has a separate ephemeral thread, at most 40 requests, bounded text, a five-minute turn deadline and 30-minute idle cleanup. No Codex tokens or arbitrary app-server methods are exposed to the phone. Stop, reset and phone removal terminate the corresponding process. An already executing browser action may finish.

Mobile chat selects GPT-6.1 Terra when it appears in the signed-in account's model catalog, otherwise the catalog default. It uses low reasoning when supported, otherwise that model's advertised default. These settings are per phone thread and do not modify the owner's development configuration. Browser tool descriptions omit repeated desktop setup instructions; all account, phone, website and tool restrictions remain enforced by the existing server. Requests to open or show a tab may pass `show:true` or `active:true`; background reading retains background behavior. Showing an existing tab also focuses its Chrome window.

Phone chat takes its tools directly from the authenticated phone MCP catalog. With all browser capabilities enabled, 38 tools are available, including drawing, hovering, form filling, iframe controls, page checkpoints, browser scripts, observers, file actions and batches. Disabled capabilities and explicit tool restrictions are omitted and still refused at dispatch, including inside batches. Profile switching and other task workspaces remain unavailable. Newly enabled tools require a fresh chat thread because the catalog is set when the thread starts.

For canvas work, the assistant inspects the page, activates its drawing tool, sends strokes in viewport CSS pixel coordinates and checks the result with a screenshot. Drawing is browser pointer control; image generation and editing are not connected to mobile chat, and portrait likeness is not guaranteed. Browser scripts run only on permitted webpages. Uploads require a requested computer file inside the configured upload directory; the app has no phone-file picker yet. Downloads and PDFs remain on the paired computer rather than being delivered to the phone. Cookie values stay hidden unless separately enabled by the computer's policy. Saved page checkpoints are private to each phone's workspace; desktop checkpoints remain profile-scoped. Longer tool calls share the conversation's five-minute deadline and can still be stopped.

Drawing has a size-based command budget, capped at four minutes, while each stalled mouse event still times out after 20 seconds. Interrupted drawings report completed strokes and are not automatically replayed. An older extension worker still applies the previous whole-drawing timeout; reload the extension after installing this worker update.
