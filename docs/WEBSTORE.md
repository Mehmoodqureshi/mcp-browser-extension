# Publishing the extension to the Chrome Web Store

Everything below is what the developer dashboard asks for, ready to paste.
Upload is manual: https://chrome.google.com/webstore/devconsole with the
Google account that owns the listing (one-time 5 USD developer registration).

## 1. Build the upload

```bash
npm run pack:ext
```

Produces `mcp-browser-extension-<version>.zip` at the repo root from a fresh
`extension-dist/` build, with `pairing.json` excluded. The manifest `version`
must be higher than the last one uploaded. It comes from
`extension/manifest.json` and changes when the extension changes.

## 2. Store listing

**Name (75 chars max):** MCP Browser Extension – AI agent in your logged-in Chrome

> Matches the manifest `name`. Google's branding rules allow "for Chrome" as a
> trailing qualifier; what they refuse is a name that leads with the trademark,
> so keep the word order exactly as above.

**Summary (132 chars max):**
Lets your AI agent use the Chrome you are signed into, through a local MCP server. Deny-all by default.

> Comes from the manifest `description`. Never list AI client names (Claude,
> Cursor, Codex...) here or in the description: 0.9.29 was rejected for
> "excessive keywords" on 2026-10-18.

**Description:**
MCP Browser Extension is an open-source MCP server and extension (MIT) that lets an AI agent on your own computer use the Chrome you already have open: your sessions, your cookies, your logins, with no separate automated browser.

How it works
- You start the MCP Browser Extension server (npm package mcp-browser-extension) from your MCP client.
- On first use, enter your email in the client's prompt or local browser form that opens automatically and open the sign-in link, then click Verify this device. The server reports verification and continues the waiting browser action.
- This extension connects to that server on 127.0.0.1 and carries out its commands: tabs, navigation, clicks, typing, page reads, screenshots, downloads.
- The extension sends browser results to your local server, which forwards them to your configured MCP client. An optional tunnel allows remote clients to connect using a private access key. Optional proxy IP checks contact ipinfo.io or api.ipify.org.

Safety
- The server is deny-all by default. You choose which domains the agent may touch; everything else is refused before a command runs.
- Clicking and typing, downloads, uploads, and script evaluation are each separate opt-ins on the server.
- Every call is recorded to a local history file so you can see what the agent did afterwards.
- Recent activity in the popup and Settings shows up to 100 extension requests during the current Chrome session, without page text or entered values.
- Stop access disconnects all apps in this Chrome profile and stays stopped across restarts. Resume connection requires fresh app approval. An action already running may finish.
- The cookie-reading tool hides cookie values by default; exposing them requires an explicit server setting.

Setup
1. Install and register the server: see https://mcp-browser-extension.com/docs/quickstart
2. Install this extension.
3. Complete email verification from your MCP client's first browser tool call.
4. Click the toolbar icon, open Settings, and click Connect to pair with your local server if it is not already paired. Manual port and token pairing is also available. A green badge means connected.

Website and docs: https://mcp-browser-extension.com
Source, docs, and issues: https://github.com/Mehmoodqureshi/mcp-browser-extension

**Category:** Developer Tools
**Language:** English
**Official URL:** https://mcp-browser-extension.com/ (select this verified site in Additional fields; changing the manifest does not update it)
**Homepage URL:** https://mcp-browser-extension.com
**Support URL:** https://github.com/Mehmoodqureshi/mcp-browser-extension/issues

## 3. Graphic assets

- Icon 128x128: `extension/icons/icon128.png` (uploaded automatically from the manifest).
- Screenshots, at least one, 1280x800 or 640x400 JPEG or 24-bit PNG without alpha: capture the current Settings page and its connection and proxy controls. Use actual product screens with credentials hidden.
- Small promo tile 440x280 (required).
- Marquee promo tile 1400x560 (optional). Use the current product name and
  `mcp-browser-extension` command in both promotional images.
- Promo video: https://www.youtube.com/watch?v=Y_uLgIZwzi8
  ("MCP Browser Extension: 2 real workflows", public, embedding available).

## 4. Privacy tab

**Single purpose:** Connects this browser to the MCP Browser Extension server running on the same computer so a local AI agent can drive it.

**Permission justifications:**
- `tabs`: list, open, close and switch tabs on the server's instruction.
- `scripting`: run the read and interaction commands (text, HTML, click, type) inside allowlisted pages, and draw the optional outline that marks tabs the agent is working in (a user stylesheet, removed when the agent stops or the server disconnects).
- `downloads` (optional): requested from Extra permissions when a download is needed; saves files from approved websites into the local task folder.
- `storage`: keep the pairing token, a random install id (sent only to the local server), the ids of tabs it opened (session storage, so it never reuses one of the user's tabs), connection state, profile name, the user's "Outline the tabs" setting, app approval records, the durable Stop access setting, and the local server's allowed sites plus up to ten recently refused host names. Trusted session storage also holds up to 100 recent request summaries (time, command, hostname, app name/key and outcome), with no page text, entered values or full URLs. Clear history removes those summaries; Chrome clears them on exit or extension reload. Nothing in storage leaves the computer.
- `alarms`: a 30-second keepalive so the service worker stays connected.
- `cookies` (optional): requested from Extra permissions when a cookie read is needed. Only approved websites can be read; the server separately controls whether values may be returned.
- `webNavigation`: know when a navigation the server triggered has committed or finished loading, so `navigate` / `reload` / `back` / `forward` return as soon as the page is ready instead of polling. Never used to observe browsing the server did not request.
- `debugger`: trusted OS-level input on framework-controlled inputs and screenshots of a specific tab without focusing it. Attached only for those commands and detached afterwards.
- `nativeMessaging` (optional, requested only when the user clicks Connect): fetch the port and token from the local MCP Browser Extension server's helper, so pairing is one click instead of copying a token. The helper runs on the user's computer, is registered by the server the user installed, and only answers the pairing.
- `proxy`: Chrome does not support this as an optional permission. Proxy routing is off until the person saves an enabled proxy in Settings, and applies to the whole profile. Never set by the agent or server.
- `webRequest` + `webRequestAuthProvider` (optional): requested when the person saves a proxy with a username. Only proxy challenges (`isProxy`) from the configured host are answered. Chrome also limits these events to granted hosts; it may ask the person to log in on other sites.
- `privacy` (optional, requested only when the user ticks "Stop WebRTC from revealing the real IP"): set WebRTC to proxied connections only while the proxy is on.
- No required host permissions. `optional_host_permissions` declares HTTP and HTTPS sites so a person can click Allow to request a named website. No all-site request is made. The website must pass both the server allowlist and Chrome permission checks. Remove also removes Chrome's corresponding grant.
- `debugger` remains required because Chrome does not support it as an optional permission. It carries a broad Chrome warning; the command router and debugger entry point check website permission before use. This is an application-enforced restriction for debugger operations, not a Chrome sandbox boundary.

**Remote code:** No. All code is bundled.

**Proxy:** the proxy host, port, username and password stay in this Chrome profile's extension storage and are never sent to the server. Check IP requests access to `https://ipinfo.io` and `https://api.ipify.org`; only after that approval may Check IP or `proxy_status` contact those services.

**Data usage:** check "Website content", "Authentication information" (cookies), "Web history" (from 0.9.16 the extension keeps up to ten recently refused host names locally for the Allow button), and "Personal communications" if the user's allowlist includes such sites. Certify: not sold, not used for unrelated purposes, not used for creditworthiness. Browser results go to the local server and then the configured MCP client, including remote clients when the user enables a tunnel. Proxy IP checks contact the services described above.

**Privacy policy URL:** https://mcp-browser-extension.com/docs/privacy

## 5. Reviewer test instructions

The extension uses email-link verification rather than a shared test password.
Leave the username and password fields blank. Paste the following into
**Additional instructions** (500 characters maximum):

```text
Register: npx -y mcp-browser-extension@latest --allow-domain example.com --enable-mutations --persist-token. Call chrome_status. Enter your email in the prompt or local form link, then open the email link and click Verify this device. If ACCESS_PENDING, call chrome_status again. Install this extension, open Settings and click Connect if unpaired. Ask the agent to open https://example.com and read its heading. No shared password. Setup: https://mcp-browser-extension.com/docs/quickstart
```

## 6. Distribution

The existing listing is **Public**, free of charge, and available in all regions.
Keep those settings when updating its branding or setup instructions.

## 7. Known difference from the unpacked install

A store-installed extension lives in Chrome's own profile folder, which the
server cannot write into, so the zero-paste pairing that works for
`~/mcp-browser-extension` does not apply. Store users pair once from the Options
page. Keep `--persist-token` in the server config so they never do it again.
