# Privacy policy — MCP Browser Extension

Last updated: 2026-10-20

MCP Browser Extension is an open-source tool
(MIT, https://github.com/Mehmoodqureshi/mcp-browser-extension) that lets an AI agent
running on your own computer drive the Chrome you already use.

## What the extension does

It opens a WebSocket connection to the MCP Browser Extension server (npm
package `mcp-browser-extension`) running on the same
machine, at `127.0.0.1` only, and carries out the commands that server sends:
listing and opening tabs, navigating, clicking, typing, reading page text and
HTML, taking screenshots, reading cookies and site storage, and saving
downloads. The server is started by you, on your computer, from your MCP
client (for example Claude Code or Claude Desktop).

## What data it handles

- Page content, screenshots, cookies, and site storage of the tabs the server
  asks about. This data is sent only to the local server over the loopback
  interface. The server hands it to the AI client you configured.
- A pairing token and port, stored in the extension's local storage, so the
  server can tell this browser apart from any other local program.
- Up to 64 client connection records: public signing keys, fingerprints, app-supplied
  names, approval decisions and expiry times. They stay in this Chrome profile's
  local storage. Approvals last eight hours; expired records may be removed when
  a new request arrives. Private signing keys remain in the requesting server
  session's memory and are never sent to the extension.
- A random install id, created on first run and sent only to the local server,
  so it can tell two Chrome profiles apart and keep each one's name.
- The connection state, the profile name you chose or were given, and your
  "Outline the tabs" setting, also in local storage.
- A persistent stopped-access setting. Stop access disconnects this Chrome
  profile and revokes its app approvals. Resume connection requires a person
  to approve each app again; website and proxy settings are preserved.
- Up to 100 recent extension requests in trusted session storage: time,
  command name, website hostname or blank-page address, browser-session tab ID, app-supplied name, verified public-key
  fingerprint and outcome. No full URLs, arguments, typed values, page content,
  cookies or error-message text is stored in this history. Clear history removes
  it immediately; Chrome also clears it on browser exit or extension reload.
  Requests refused by the server before reaching Chrome may be absent.
- The ids of the tabs it opened itself (numbers only, in session storage that
  Chrome clears when it closes), so it reuses only its own blank tabs and never
  one of yours.
- The list of sites the local server currently allows, and up to ten site
  names (host names only, such as `example.com`; never full addresses or page
  content) that the server recently refused, so the Options page can show them
  with an Allow button. They stay in local storage until you allow or dismiss
  them. When you click Allow or Remove, that host name is sent to the local
  server only.
- Up to 100 dismissed website names in local storage, so a dismissed setup
  suggestion stays hidden. A new request for that site makes it visible again;
  dismissing a suggestion never grants access.

## One-click Connect

The Connect button uses Chrome's native messaging. The MCP Browser Extension
server registers a small helper with your browsers each time it starts; when you
click Connect (and allow the optional "communicate with cooperating native
applications" permission), the extension asks that helper for the port and token
from `~/.mcp-browser-extension/handshake.json` and saves them like a manual pairing would.
It all happens on your computer. Chrome allows only this extension to start the
helper, and the helper answers nothing but the pairing.

## Proxy (optional, off by default)

On the Options page you can route that Chrome profile through a proxy you
choose. The proxy address, username and password are stored in the
extension's local storage in that profile only. They are never sent to the
local server or to the AI agent, which can only read whether the proxy is on,
its address, and the IP sites see. The extension answers your proxy's login
prompt with the saved credentials and nothing else.

To show which IP sites see, the extension requests `https://ipinfo.io/json`
(or `https://api.ipify.org` if that fails) when you click Check IP or the
agent calls `proxy_status`, after you have approved the lookup websites using
Settings → Proxy → Check IP. That request carries nothing but itself; those
services see the IP it comes from, which is the point of the check. With the
optional WebRTC setting ticked, the extension also limits WebRTC to proxied
connections while the proxy is on.

## What it does not do

- It never sends any data to the extension author or to any remote server.
  Apart from the IP check described under Proxy, the only network endpoint it
  connects to is `127.0.0.1`.
- It does not collect analytics, telemetry, or crash reports.
- It does not run remote code. All code is in the package you install.
- It does nothing until you pair it with a local server, and it acts only on
  the domains that server's allowlist permits. The server ships deny-all by
  default.

## Which sites it can touch

Website access requires both a matching entry in the server allowlist and a
Chrome permission for that website. Click Allow in the toolbar popup or Settings
to request both; accept Chrome's prompt if shown. Server flags alone do not
grant Chrome permission. Remove also removes the corresponding Chrome host grant.
The extension has no required host permissions and never requests all-site access.
Upgrades remove inherited blanket host grants, so previously configured websites
may need your approval again. The extension refuses browser commands aimed at
its own approval pages.

Allowing a website lets approved apps read and take actions there, including
sending messages, deleting information and making purchases, subject to configured
tool permissions. There is no separate approval for each action. Website access
is remembered until removed; each app still requires its own unexpired approval.
Removing either access blocks new commands but cannot undo completed actions.

Cookies and downloads require separate optional permissions, offered only when
needed under Extra permissions. Proxy authentication and IP lookup permissions
are requested from Settings when you enable those features. Chrome does not allow
`proxy` or `debugger` to be optional. The latter remains required for screenshots
and trusted input and still carries Chrome's
broad warning. The extension checks website permission before debugger use.
These application checks do not make debugger a host-restricted Chrome API.

## Data retention

Nothing is retained by the extension beyond the local and session storage described above. You
can clear them by removing the extension. Anything the server saves
(screenshots, downloads, action history, and the sites you allowed from the
Options page, in `allowed-sites.json`) lives in `~/.mcp-browser-extension` on your own
machine under your control.

## The MCP Browser Extension server (separate from the extension)

This policy covers the extension, which sends browser results to your local
server and makes the optional proxy IP checks described above. The server
forwards results to your configured MCP client. If you enable `--http` or
`--tunnel`, clients with your remote access key can request browser actions and
receive results within your allowed sites after you approve each session in Chrome. `--tunnel` uses Cloudflare to expose
the local HTTP endpoint; its URL includes the access key and must stay private.
Restart with `--rotate-remote-key` to revoke access.

By default, the server asks for an email the first time you use a browser tool. The
website sends a Firebase email sign-in link; opening it and confirming
**Verify this device** verifies the address and
grants access to that server installation. Firebase Authentication stores the
email address. Firestore stores the Firebase user id, a hash of a random device
secret, whether that device is active, and short-lived verification requests.
The server stores the random device id and secret locally in
`~/.mcp-browser-extension/access.json` with owner-only file permissions on POSIX systems.
On Windows, the file inherits the ACL of the user's profile directory. The
address is entered through the MCP client's input prompt or, when that prompt
is unavailable or dismissed, a temporary form bound to the local loopback
address. The server opens that form in the default browser and also returns its
link. The form expires after 10 minutes. The email is sent by the local server to
the MCP Browser Extension website to request the sign-in email. The account
can be disabled in Firebase Authentication, and an individual device grant can
be revoked in Firestore.

For trusted local or unattended use, the server operator can disable this check
with `--no-email-verification` or `MCP_BROWSER_EXTENSION_EMAIL_VERIFICATION=0`.
In that mode, no email address or device grant is sent to Firebase, and any
process that can use the local MCP server is trusted subject to its domain and
capability policy. The option cannot be combined with `--tunnel`.

The MCP Browser Extension server also makes these outside requests:

- **Anonymous usage statistics**, to PostHog: a random install id (not the
  extension's), its version, OS, CPU architecture, Node version, whether the
  session owns or shares the bridge port, how many browsers are paired, the
  paired extension's version and whether it is the store or an unpacked copy,
  and, when
  none is, which of a few fixed reasons applies (`no_extension`,
  `token_mismatch`, `version_mismatch`, `profile_mismatch`), counts of tool
  calls and error codes, and for each tool call its name and group, duration,
  whether it failed and the error code, the AI client's name and version (such
  as `claude-code`), the MCP protocol revision, the AI model name when the client
  includes it in its own request metadata, and a random session id. When a
  client connects, its name and version and the list of tool names offered. It never sends URLs, site names, page content, tool
  arguments, cookies, profile names or anything the extension reads. Events are
  personless and GeoIP lookup is disabled. Turn it off with
  `MCP_BROWSER_EXTENSION_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `--no-telemetry`. Details:
  https://github.com/Mehmoodqureshi/mcp-browser-extension#telemetry
- **An update check**, to the npm registry (`registry.npmjs.org`), once at
  startup, asking only for the latest version number of
  `mcp-browser-extension`. It carries no install id or usage data; npm
  sees what any package download shows it (your IP address). When a newer
  version exists, the server starts it through `npx`, which downloads it from
  npm. Turn it off with `MCP_BROWSER_EXTENSION_AUTO_UPDATE=0` or `--no-auto-update`.

## Contact

Open an issue at https://github.com/Mehmoodqureshi/mcp-browser-extension/issues.
