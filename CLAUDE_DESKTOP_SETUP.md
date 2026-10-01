# Claude Desktop setup

Build the server with Node.js 22 or newer:

```powershell
cd C:\absolute\path\to\adt-mcp-app\mcp-server
npm install
npm run verify
```

Open the Claude Desktop configuration:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add a demo configuration and use an absolute path:

```json
{
  "mcpServers": {
    "adt-security": {
      "command": "node",
      "args": ["C:/absolute/path/to/adt-mcp-app/mcp-server/dist/main.js"],
      "env": {
        "ADT_DEMO_MODE": "true"
      }
    }
  }
}
```

Restart Claude Desktop. The server exposes the dashboard plus text-compatible tools.

For a real account, put `ADT_USERNAME`, `ADT_PASSWORD`, optional `ADT_MFA_TOKEN`, and optional `ADT_SYSTEM_ID` in the `env` object. Do not send credentials in a conversation. Real mode remains read-only until `ADT_ALLOW_MUTATIONS` is explicitly set to `true`.

Every command uses a preview-and-confirm flow. Claude should call `prepare-security-action`, present the exact summary, and only then call the matching mutation tool with the returned token.

If tools do not appear, validate the JSON, confirm the `dist/main.js` path, run `npm run verify`, and restart Claude Desktop. See [README.md](./README.md) for the full configuration and security contract.
