# Security Step 2: Optional Browser Permissions

Step 2 asks Chrome for sensitive permissions only when the person uses the related feature, and ties website access to named sites.

## Website permissions

The extension does not request blanket host access at installation. It requests access for a named HTTP or HTTPS website after the person chooses **Allow** in the extension popup or Settings. Browser access requires both that Chrome permission and the MCP server’s named-site grant. Removing website access removes the Chrome host permission as well as the server grant.

The extension migration removes inherited all-site access and initial cookies and downloads permissions. It preserves an already enabled proxy instead of silently changing the person’s network route.

## Sensitive features

Cookies and downloads are optional and requested when the person uses those features. Proxy authentication permissions are requested when configuring an authenticated proxy and removed when that proxy is disabled. IP-check requests separately request access to their named services. A denied or removed Chrome permission blocks the corresponding operation.

## Required Chrome permissions

Chrome does not allow some permissions used by this extension to be optional. The manifest therefore still requires `debugger` and `proxy`, along with browser APIs used for tabs, scripts, storage, alarms, and navigation. The extension checks the website before debugger operations, but Chrome does not restrict the debugger permission itself to the MCP allowlist. This is an application-level check, not a browser-enforced per-site sandbox.

Optional permission prompts are controlled by Chrome and must be accepted by the person. App approval, server policy, and a client’s permission mode cannot grant a missing Chrome permission.
