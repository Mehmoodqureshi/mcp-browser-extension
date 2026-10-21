# Security Step 4: Activity and Stop Access

Step 4 gives the person using Chrome a quick view of MCP activity and a durable way to stop browser access from the extension.

## Activity history

The toolbar popup shows the latest five MCP activity rows. Settings can show up to 100 entries and filter them by outcome. Successful opening and closing of the same tab by the same approved app are grouped into one row; the row can be expanded to see the app name, verified key fingerprint, and times.

Each entry records the time, command, website hostname, app-supplied name, verified signing-key fingerprint, and outcome. It does not record page content, command arguments, cookies, typed values, full URLs, or raw error messages. Health and approval probes are omitted. The history is held in Chrome session storage and clears when Chrome closes or the extension reloads. Clearing history also prevents late results from restoring cleared entries.

This is a convenience history, not a complete or tamper-proof audit. Requests rejected before reaching the extension may be absent, and a storage failure can leave the history incomplete. “Interrupted” means the result was withheld or lost; the browser action may still have finished.

## Stop and resume

**Stop access** immediately blocks new command checks, closes the extension’s connection to the MCP server, saves a persistent stop, revokes all approved app keys, clears activity borders, and unregisters observer scripts for future pages.

The stop survives worker eviction, Chrome or extension restarts, keepalive alarms, pairing changes, and ordinary reconnect attempts. Only a trusted click on **Resume connection** in the extension popup or Settings resumes the connection. Every app must then be approved again. Website permissions and proxy settings are preserved.

Stop applies to the current Chrome profile. It does not stop the MCP server or affect other Chrome profiles. Commands already executing and scripts already injected into a page may finish; Stop cannot undo completed actions. Results from old requests are withheld after Stop or a connection replacement. A failed save blocks access in the current worker, but the user should retry Stop before relying on it across a restart.

## Security boundary

App approval, website approval, and Stop are separate controls. Removing access prevents future commands; it cannot undo actions already completed on a website. An approved app can still make mistakes or follow malicious instructions found on an allowed website, subject to the configured tool permissions.
