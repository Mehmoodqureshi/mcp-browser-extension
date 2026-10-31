# Client approval

Related security steps: [Step 1: App and Website Approval](SECURITY-STEP-1.md),
[Step 2: Optional Browser Permissions](SECURITY-STEP-2.md),
[Step 3: Per-Action Approval Decision](SECURITY-STEP-3.md),
[Step 4: Activity and Stop Access](SECURITY-STEP-4.md), and
[Step 5: Download and Bridge Hardening](SECURITY-STEP-5.md).

The extension requires a person to approve each new MCP app session in its Chrome
popup or Settings before it can read or act on browser pages. This is independent of
email verification, transport pairing, domain restrictions and client permission
modes. No command-line flag disables this extension gate.

## Using it

1. Start the app's MCP connection and run `chrome_status`.
2. Click the extension's toolbar icon to open **App connections** in the popup.
   The same controls are available in **Settings**.
3. Compare the key fingerprint with the tool result. The app name is supplied by
   the requesting app and is not proof of its identity.
4. Click **Approve for 8 hours**, then retry the tool.

A request expires after ten minutes. Approval lasts eight hours in that Chrome
profile. Expired access requires a new approval. Each initialized MCP session,
including each remote HTTP session, receives a new key. Restarting a session
requires approval again. Several sessions with the same name are separate keys.

App approval does not supply Chrome website permission. **Suspicious-site checks**
are selected by default. A person clicks **Allow website access** in the popup or
Settings and accepts Chrome's optional HTTP/HTTPS permission once. Ordinary sites
then work automatically; only local warnings need Allow. Before that grant, the
extension asks for setup without queueing ordinary websites. **Use per-site
approval** or **Turn off** explicitly selects the named-site mode; that choice is
remembered. Old inherited broad permissions are still removed during migration.
Server flags cannot supply the Chrome grant or override the browser preference, and
`--no-site-grants` disables it. The retired `--unsafe-all-domains` flag and
catch-all allowlist entries remain unsupported.

The local rules check selected brand impersonation patterns, lookalike addresses,
unencrypted password pages and destinations, explicit GET password forms, and
password pages claiming a recognised brand outside its configured domains. A
password field or an internationalised domain alone is not a warning. The brand
list is limited, and these rules can miss scams or flag legitimate sites. This
is not antivirus, a reputation database, or protection against prompt injection.
Form checks run after loading, before app reads or actions; page scripts can run
while loading. Form checks cover visible password inputs in the targeted document;
closed shadow roots, canvas interfaces and arbitrary script-driven submissions
are not inspected. New page states are checked on subsequent commands and between
batched form fields; this does not make page changes and actions atomic.

Warnings and approvals stay in the Chrome profile. Approval covers the displayed
reason IDs at an exact origin (scheme, hostname and port); changed reasons need
review again. A stale Allow click cannot approve a newly changed warning. Removing
an exception makes the next matching check wait again. Blocked websites remain
blocked until restored. Turning automatic access off removes its broad Chrome
grant and returns to named-site access. Revoking that Chrome grant requires setup
again. Automatic checks never auto-approve an app or a Chrome permission dialog.

The server negotiates signed `site_check` support per paired browser, including
through peers. It checks tool capabilities before asking that browser for a site
decision, and the worker checks the actual page again before execution. Old
extensions retain the original server allowlist gate. Observer hooks in automatic
mode are installed on demand after checking the page, never across every site at
document start. Late navigation warnings withhold results without automatically
replaying an action that already started.

Allowing a website permits approved apps to read and take actions there, subject
to configured tool permissions. This includes sending messages, deleting
information and making purchases. The extension does not ask again for each
action. Website grants are remembered until removed and apply to all approved
app sessions; app access still expires after eight hours.

These controls restrict which apps and websites are accessible. They do not
prevent an approved app from making a mistake or following malicious page
instructions on an allowed website. Removing access blocks new commands; it
cannot undo completed actions.

Use **Remove access** to block subsequent commands from one key. An action already
running may finish. **Approve again for 8 hours** explicitly restores that key. If
either view reports a storage error, the decision was not saved: resolve the error
and retry before relying on it across an extension restart.

## Activity and stopping access

The popup shows the latest five activity rows received by the extension. Settings
shows history from up to 100 requests, filtered by Running, Done, Blocked, Failed
or Interrupted. Successful opening and closing of the same tab by the same app
share one row; expand it to see the app, key and times. Browser-session tab IDs
are stored only to match those actions. Blank tabs display their blank-page address.
Entries contain a timestamp, command name, website hostname, app-supplied name,
verified signing-key fingerprint and outcome. Invalid or unsigned identities
are shown as Unverified app. Health and approval probes are omitted.

This history stays in trusted Chrome session storage and is cleared when Chrome
closes or the extension reloads. Clear history removes it from both views;
results from requests already running when cleared do not recreate their entries.
No request arguments, page contents, screenshots, cookies, typed values, full URLs
or raw error messages are recorded. Requests refused before reaching Chrome may
be absent. It is a convenience history, not a complete or tamper-proof audit.
Interrupted means that a result was withheld or lost; an action may still have
finished. A successful command does not establish that a website accepted its
business operation.

**Stop access** immediately invalidates pending command checks, closes the
extension's bridge connection and saves a durable stop. It revokes all app keys,
clears activity borders and unregisters observer scripts for future pages.
Already-injected hooks and commands already executing may finish; Stop cannot
undo completed actions. Results from old requests are not delivered after Stop
or to a replacement connection.

The stop survives worker eviction, Chrome/extension restarts, keepalive alarms,
pairing changes and ordinary Reconnect requests. **Resume connection** is a
separate trusted click in the popup or Settings. It reconnects using the saved
pairing; each app must then be approved again. Website permissions and proxy
settings are preserved. Stop applies to this Chrome profile, not other profiles
or the local MCP server process.

Failed stop persistence blocks access in the current worker and reports an error;
retry before relying on the setting across restarts. No CLI flag or ordinary
page message can resume access or erase this history.

## Enforcement

Each session creates a P-256 key pair in memory. Only the public key travels to
the bridge and extension. Chrome saves the public key, its SHA-256 fingerprint,
the supplied app name, decision and expiration. Private keys never enter pairing
files, extension storage, logs or tool results.

The session signs the method, JSON parameters, target tab, timeout, protocol
version, app identity, timestamp, random nonce and a challenge generated by the
extension for that WebSocket connection. Chrome verifies the signature and grant
before resolving the target tab, then rechecks the grant before execution.
Commands older than two minutes, invalid signatures and replayed nonces are
refused. Reconnecting changes the challenge, including after a worker restart.

A hub forwards a peer's original signed request. It never lends its own key to
an incoming peer. The shared bridge token remains a transport credential; knowing
it does not provide an approved signing key. Profile renames also require a
signed approval probe for the exact rename. Peer status no longer broadcasts
cached page URLs.

The only unsigned command is an empty health probe. It returns a constant response
without looking up a tab or exposing a URL. Client approval requests carry valid
signatures; pending requests and replay tracking are bounded. An unavailable
approval store blocks access. Grant writes must succeed before access is enabled.

Only the exact top-level extension Settings or popup page can send decisions.
Approval buttons ignore synthetic clicks. Browser commands cannot read or drive
the extension's own approval pages. Extension local storage is restricted to
trusted extension contexts.

## Compatibility and limits

Update the MCP server and extension together. The additive `client-approval-v1`
capability signals support. Updated servers refuse browser commands to older
extensions; updated extensions refuse unsigned commands from older servers.
Transport pairing may succeed while browser access remains blocked.

This is session authorization for the extension, not isolation between approved
apps. Approved apps still share permitted tabs and the existing browser policy.
Website content access additionally requires Chrome host permission: the explicit
HTTP/HTTPS grant for automatic access, or individually named sites. In named-site
mode, Allow requests Chrome permission before adding the server grant, and Remove
revokes the host permission. In automatic mode, Block keeps a site inaccessible
without removing the shared broad grant. Server flags, saved app approval and
YOLO mode cannot supply the Chrome grant. Cookies and downloads also require
their optional API permission. Debugger and proxy remain required permissions
because Chrome does not support them as optional; debugger access is checked
against website permission by the extension, rather than isolated by Chrome.
The published CLI is extension-only; development CDP executors outside this
extension do not inherit its approval gate.

It cannot protect against someone who controls the operating system, modifies
the installed extension or server, steals a live approved private key or an
approved remote session's credentials, or persuades the
person to approve the attacker's key. A stolen approved key remains useful until
revoked or expired. No independent security audit has been completed for this
change, and it is not a claim that the extension is unhackable.

## Verification

`test/client-approval.test.ts` exercises signatures, tampering, replay,
independent keys, expiry, revocation, storage errors, sender restrictions and
concurrent session identity propagation. `test/e2e/client-approval.test.ts` uses
the real extension in isolated Chromium to verify trusted approval clicks,
self-approval rejection, popup and Settings synchronization, revocation, shared-token attacks and separate MCP
sessions when email verification is bypassed. The existing browser suites also
exercise commands after explicitly approving their test client in Chrome.

For an isolated build that does not overwrite a folder loaded in your main
Chrome profile, set `MBE_EXTENSION_BUILD_DIR` when building and running E2E tests.
