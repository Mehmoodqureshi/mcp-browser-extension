# Security Step 3: Per-Action Approval Decision

The planned per-action confirmation gate was removed after the owner chose a simpler website-approval model. Per-action approval is not part of the current security behavior.

## Current behavior

After an MCP app is approved and a website is allowed, the app can read and act on that website without a new extension prompt for each click, typing action, message, deletion, or purchase. Configured tool permissions and capability flags still apply. App approval and named-site restrictions remain in force.

## Security tradeoff

This reduces repeated prompts, but it also removes a checkpoint against an approved app making a mistake or following malicious instructions in page content. A website grant may therefore allow high-impact actions on that site. The activity history can help review what the MCP requested, and Stop blocks future commands, but neither can undo a completed website action.

For stronger protection, keep website grants narrow and remove them when they are no longer needed. Do not describe website approval as transaction-specific confirmation or as protection against prompt injection on an allowed site.
