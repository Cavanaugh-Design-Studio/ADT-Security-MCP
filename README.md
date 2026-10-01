# ADT Security MCP Server
Control and monitor an ADT Control / Alarm.com security system from any MCP-compatible host. This local stdio MCP server pairs structured, text-first tools with an interactive MCP App dashboard, so you can check system and device state, review recent activity, and safely arm, disarm, lock, or adjust devices, all backed by a two-step confirmation flow and a local, credential-free audit trail.

Developed by Anthony Cavanaugh for **Cavanaugh Design Studio**

## Requirements

- Node.js 22 or newer
- An MCP host that supports stdio. MCP Apps support is optional because `open-standalone-dashboard` provides the same dashboard in a browser.
- Optional ADT Control credentials for real-device reads

## Install and verify

```powershell
npm install
npm run verify
```

`verify` runs strict TypeScript checks, unit and in-memory MCP contract tests, a clean production build, and a process-level stdio/standalone negotiation test against the built artifact. Before publishing, use `npm run release` to add the production dependency audit and package-content dry run.

## Configuration

Credentials are read only from the server process environment. They are never accepted as tool arguments or stored in the audit log.

| Variable | Meaning |
| --- | --- |
| `ADT_DEMO_MODE` | Set `true` to force the stateful demo provider. Demo is also selected when no username/password are configured. |
| `ADT_USERNAME` | ADT Control / Alarm.com account username. Must be set with `ADT_PASSWORD`. |
| `ADT_PASSWORD` | Account password. |
| `ADT_MFA_TOKEN` | Optional token supported by the upstream client. |
| `ADT_SYSTEM_ID` | Required when the account exposes more than one system. |
| `ADT_ALLOW_MUTATIONS` | Real accounts are read-only unless set to `true`. |
| `ADT_AUDIT_LOG_PATH` | Optional audit path. Default: `~/.adt-mcp/audit.jsonl`. |
| `ADT_STANDALONE_PORT` | Optional loopback dashboard port. Default: an available ephemeral port on `127.0.0.1`. |

Partial real credentials fail closed. When multiple systems are available, the server refuses to guess.

## Host configuration

Build first with `npm run build`, then configure the host with an absolute path:

```json
{
  "mcpServers": {
    "adt-security": {
      "command": "node",
      "args": ["C:/absolute/path/adt-mcp-app/mcp-server/dist/main.js"],
      "env": {
        "ADT_DEMO_MODE": "true"
      }
    }
  }
}
```

For a real account, replace the demo flag with credentials but omit `ADT_ALLOW_MUTATIONS` initially. Confirm the dashboard selects the expected system and devices, then explicitly add `"ADT_ALLOW_MUTATIONS": "true"` if device control is desired. Restart the host after configuration changes.

## Tools

| Tool | Behavior |
| --- | --- |
| `adt-dashboard` | Reads live system/device state and local recent activity. |
| `prepare-security-action` | Validates a proposed mutation and returns a short-lived one-use token. |
| `arm-system` / `disarm-system` | Controls an exact panel using a matching confirmation token. |
| `control-lock` | Locks or unlocks an exact device using a matching token. |
| `control-light` | Turns a light on/off and optionally sets dimmer brightness. |
| `set-thermostat` | Sets off, heat, cool, or auto mode with bounded Fahrenheit setpoints. |
| `get-alerts` | Derives and prioritizes current alerts from live device state; the dashboard presents these explicitly. |
| `get-event-history` | Reads the redacted local MCP action audit, not provider history; the dashboard uses this dedicated workflow. |
| `get-camera-snapshot` | Downloads a supported camera image server-side without exposing the signed provider URL. |
| `open-standalone-dashboard` | Creates an expiring, interactive loopback dashboard URL for clients without MCP Apps or with constrained frames. |

Every mutation is a two-step operation: call `prepare-security-action`, show its exact summary to the user, then pass its one-use token to the matching mutation tool. Tokens expire after two minutes and cannot be reused or applied to a different action.

## Security and operations

- The transport is local stdio; stdout is reserved for JSON-RPC. Diagnostics use structured stderr.
- The fullscreen control first requests native host fullscreen. If the host rejects it or stays inline, the app uses the standard host open-link request to open a separate browser dashboard.
- Standalone dashboards bind only to `127.0.0.1`. The URL contains a two-minute, one-use bootstrap token; the page exchanges it for a one-hour browser-only session, stores that session in tab-scoped storage, and removes the bootstrap token from the address bar.
- The standalone browser API exposes only dashboard refresh, action preparation/commit, and camera snapshots. It reuses the same validation, mutation policy, one-use confirmations, provider, and audit log as the MCP tools; ADT credentials remain server-side.
- Browser mutations require an authenticated session, exact same-origin requests, JSON bodies capped at 16 KB, and the same visible two-step confirmation dialog used in the MCP App.
- Real mutations are disabled by default.
- A command whose transport fails or times out after dispatch returns `uncertain` and disables all further device control for that server session. The upstream library cannot cancel it, so it may still complete. Inspect the operation in ADT and ensure no command remains pending before restarting; never restart solely to retry an uncertain command.
- Accepted commands whose verification read fails remain `submitted`, with a warning, rather than being recorded as failed. Partial thermostat writes are treated as uncertain.
- Authentication uses a five-minute cache independent of the upstream library's missing expiry field. Concurrent logins are coalesced; expired authentication is refreshed once for reads. Physical writes are never retried automatically.
- System state explicitly reports armed, disarmed, mixed, or unknown across every panel. `system.armed` is `null` for mixed/unknown state. The dashboard displays controls for each panel.
- Audit entries contain action type, target ID, outcome, duration, and a safe error code. Credentials and confirmation tokens are excluded.
- The audit file is created with restrictive permissions where supported and rotates at 5 MB to one backup.
- Camera downloads are bounded to 5 MB and validated as image content.
- Camera snapshot URLs must use credential-free HTTPS, resolve only to public addresses, pass the same validation after every redirect, and stream under a hard 5 MB limit.
- Camera connections use the validated IP directly while retaining the original hostname for TLS certificate verification and the Host header. One download deadline covers DNS validation, redirects, connection, and body streaming.
- The dashboard has no external connect, resource, frame, or base-URI domains in its declared CSP.

## Fullscreen and VS Code

After rebuilding and restarting the MCP server, select the maximize control beside **Refresh**. A host that supports MCP fullscreen expands the app natively. If VS Code leaves it inline, the same control requests a protected standalone dashboard through the host's open-link capability.

If VS Code denies or does not implement open-link, the app displays a copyable `http://127.0.0.1:.../mcp-app.html#token=...` URL. Run **Simple Browser: Show** from the VS Code Command Palette and paste that URL within two minutes. Keep the MCP server process running; the exchanged browser session lasts one hour.

Clients that support MCP tools but not MCP Apps can call `open-standalone-dashboard` directly and present its returned URL. The standalone entrypoint provides the complete dashboard workflow, including confirmation-gated device controls and supported camera snapshots.

## Scripts

```text
npm run typecheck   strict source and test checking
npm test            source/unit/in-memory MCP tests
npm run build       clean dashboard, server, and declaration build
npm run test:dist   built stdio protocol smoke test
npm run verify      all of the above
npm run audit:prod  production dependency audit
npm run pack:check  inspect the npm package contents without creating a tarball
npm run release     verify, production audit, and package dry run
```

## Known boundary

The integration relies on the unofficial `node-alarm-dot-com` library and private upstream behavior. It is not affiliated with ADT or Alarm.com, and upstream changes may break authentication or commands. Demo and protocol behavior are automated; release validation against a real account must be performed read-only first.

An uncertain command disables further writes only within the running server process; an upstream command may outlive a process restart. Reconcile it in ADT before restarting. A fresh browser link replaces an expired stored session; expired sessions are removed without automatically retrying actions.

Demo mode does not fabricate camera imagery. `get-alerts` reflects current state, and `get-event-history` is only this server's local action record.


## 📝 License
MIT License — see [LICENSE](LICENSE) for details.
