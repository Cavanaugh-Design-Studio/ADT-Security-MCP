# Quick start

Requires Node.js 22 or newer.

## 1. Build and verify

```powershell
cd C:\absolute\path\to\adt-mcp-app\mcp-server
npm install
npm run verify
```

## 2. Configure an MCP host

Start in demo mode:

```json
{
  "mcpServers": {
    "adt-security": {
      "command": "node",
      "args": ["C:/absolute/path/to/adt-mcp-app/mcp-server/dist/main.js"],
      "env": { "ADT_DEMO_MODE": "true" }
    }
  }
}
```

Use an absolute path and restart the host. Ask it to show the ADT dashboard or security status.

## 3. Validate a real account safely

Configure credentials in the host environment, never in chat or tool arguments:

```json
"env": {
  "ADT_USERNAME": "account@example.com",
  "ADT_PASSWORD": "replace-in-local-host-config",
  "ADT_MFA_TOKEN": "optional",
  "ADT_SYSTEM_ID": "required-only-for-multiple-systems"
}
```

Leave `ADT_ALLOW_MUTATIONS` unset for the first run. Verify the selected system, panel, locks, lights, thermostats, sensors, and cameras. Only then add `"ADT_ALLOW_MUTATIONS": "true"` if you intend to control real devices.

Mutations always require a preview and explicit confirmation. Disarm and unlock reduce physical security; inspect the exact target and action summary before confirming.

## Troubleshooting

- Server unavailable: confirm Node 22+, the absolute `dist/main.js` path, valid JSON, and restart the host.
- Dashboard absent: the tools remain usable as text; MCP Apps rendering depends on host support.
- Fullscreen remains inline: rebuild, restart the MCP server/host, and select maximize again. If VS Code does not honor native fullscreen or open-link, copy the displayed loopback URL into **Simple Browser: Show**. The standalone dashboard remains fully interactive through the same confirmation flow and requires the MCP process to remain running.
- Client has no MCP Apps support: call `open-standalone-dashboard` as a regular MCP tool and open its returned loopback URL.
- Configuration error: set both username and password, or enable demo mode.
- Multiple systems: set the exact `ADT_SYSTEM_ID`; the server will not choose one implicitly.
- Commands denied: real mode is intentionally read-only until `ADT_ALLOW_MUTATIONS=true`.
- Authentication failure: verify account credentials/MFA and remember this uses an unofficial upstream client.

See [README.md](./README.md) for the complete tool, security, audit, and limitation details.
