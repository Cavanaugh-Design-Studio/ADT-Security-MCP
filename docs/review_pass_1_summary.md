# Review Pass 1 Summary: Architecture and Structural Integrity

## Overview

The server has a sound shared-service architecture: MCP tools and the standalone HTTP entrypoint both delegate device operations to `SecurityService`, while the React dashboard selects an MCP or browser transport. The review enumerated all 11 registered tools and compared them with both UI transports. Eight workflows are complete, while three advertised capabilities have incomplete dashboard coverage.

## Checklist Completion

- [x] Pattern consistency: MCP, browser, provider, confirmation, and audit responsibilities are separated.
- [x] Dependency management: no circular source dependency was found.
- [x] Interface design: tools have schemas, annotations, structured output, and a shared UI resource.
- [ ] Complete tool/UI parity: alerts, explicit history retrieval, and thermostat auto mode need dashboard wiring.

## Tool and UI Matrix

| Tool | MCP tool | Framed UI | Standalone UI | Status |
| :--- | :---: | :---: | :---: | :--- |
| `adt-dashboard` | Yes | Yes | Yes | Complete |
| `open-standalone-dashboard` | Yes | Yes | N/A | Complete |
| `prepare-security-action` | Yes | Yes | Yes | Complete |
| `arm-system` | Yes | Yes | Yes | Complete |
| `disarm-system` | Yes | Yes | Yes | Complete |
| `control-lock` | Yes | Yes | Yes | Complete |
| `control-light` | Yes | Yes | Yes | Complete, edge cases pending Pass 2 |
| `set-thermostat` | Yes | Partial | Partial | Auto mode is missing from both UI transports |
| `get-alerts` | Yes | No | No | Warning count is derived locally; tool is never called |
| `get-event-history` | Yes | Partial | Partial | Dashboard embeds recent activity; dedicated tool is never called |
| `get-camera-snapshot` | Yes | Yes | Yes | Complete |

## Key Findings

| Category | Issue | Severity | Recommendation |
| :--- | :--- | :--- | :--- |
| UI/tool parity | `get-alerts` has no dashboard call site or presentation | P1 | Add typed alert state, a visible alerts section, and MCP/browser transport calls |
| UI/tool parity | `get-event-history` is advertised but the UI only consumes history embedded in `adt-dashboard` | P1 | Add a dedicated history call and standalone endpoint |
| UI/tool parity | Thermostat `auto` is supported by schema/provider but absent from the dashboard | P1 | Add bounded heat/cool controls and confirmation-gated auto action |
| Transport parity | Standalone HTTP lacks alerts/history endpoints | P1 | Expose authenticated read-only endpoints that delegate to `SecurityService` |
| Coupling | UI passes both a canonical `SecurityAction` and separate tool arguments | P2 | Retain for MCP compatibility, but test that every action maps to its exact tool arguments |

## Guidance for Next Pass

Trace boundary values, confirmation consumption, light brightness, thermostat target relationships, alert severity, snapshot errors, startup/shutdown cleanup, and concurrent refresh behavior. Confirm that all UI states remain correct when one of several refresh operations fails.
