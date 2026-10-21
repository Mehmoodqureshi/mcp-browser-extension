# Security Step 1: App and Website Approval

Step 1 separates approval of an MCP app from permission to access a website. Pairing or email verification alone does not authorize browser commands.

## App approval

Each initialized MCP session creates its own P-256 signing key in memory. The private key stays with that session. The extension stores the public key, a fingerprint, the app-supplied name, the decision, and its expiry.

A person approves a pending key from the extension popup or Settings. Approval lasts eight hours; a pending request expires after ten minutes. Restarting an MCP session creates a new key and requires a new approval. Access can be removed or restored for an individual key. Compare the fingerprint when reviewing a request: an app name is supplied by the requesting app and does not prove its identity.

Commands are signed with their method, parameters, target tab, timeout, protocol version, timestamp, random nonce, and a challenge from the current extension connection. The extension rejects invalid signatures, stale commands, replayed nonces, and commands from unapproved or revoked keys. Reconnecting changes the challenge. The bridge token authenticates the connection but does not replace app approval.

## Website approval

App approval does not grant access to websites. Each website needs a named server grant and Chrome host permission. The extension checks the target website immediately before running a command. All-site grants and catch-all policies are rejected, including grants sent by older servers.

Removing a site grant also removes its Chrome host permission. Removing app access blocks future commands from that key. Neither action can undo an operation that has already completed.

## Limits

Approved apps can share access to websites that the person has allowed. App and website approval cannot protect against malware controlling the computer, a modified server or extension, a stolen live credential, or a person approving the wrong key. Website approval also does not require a separate confirmation for each action; see [Security Step 3](SECURITY-STEP-3.md).
