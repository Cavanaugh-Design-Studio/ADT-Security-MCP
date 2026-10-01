# Review Pass 2 Summary: Logic, Edge Cases, and Correctness

## Overview

The confirmation store, target matching, provider mapping, and shutdown paths are generally robust. The pass found one side-effect ordering bug in thermostat auto mode, several capability/boundary mismatches, an alert-priority inconsistency, and ambiguous behavior when an action succeeds but its audit append fails.

## Checklist Completion

- [x] Boundary conditions: schemas bound IDs, temperatures, brightness, limits, request bodies, and snapshots; additional cross-field checks are required.
- [x] Error propagation: provider and expected service errors are sanitized at MCP and HTTP boundaries.
- [x] Resource cleanup: timers, stdio, HTTP servers, and signal shutdown paths release their resources.
- [ ] Side effects: invalid thermostat auto targets can change mode before rejection; audit failure can mask a completed physical action.

## Key Findings

| Category | Issue | Severity | Recommendation |
| :--- | :--- | :--- | :--- |
| Side-effect ordering | Real and demo thermostat auto mode validate `heatTarget < coolTarget` after changing mode | P0 | Validate the relationship in schemas, service preparation, and provider execution before any mutation |
| Mutation result | A successful provider action followed by audit-write failure becomes a generic tool failure, encouraging unsafe retries | P1 | Return the operation result with an explicit audit warning and emit a structured operational error |
| Capability validation | Brightness does not require the `brightness` capability; thermostat target changes only check `mode` | P1 | Validate optional action features against their exact device capabilities |
| Light behavior | UI sends brightness while turning a light off; verification can incorrectly report `submitted` | P1 | Send/verify brightness only for turn-on actions and preserve last brightness while off |
| Alert correctness | Carbon-monoxide triggers are critical in alerts but only smoke makes dashboard health critical | P1 | Use one shared critical-sensor rule |
| Alert ordering | Applying `limit` before severity ordering can omit critical alerts behind warnings | P1 | Sort critical alerts before slicing |
| UI refresh | Future multi-tool refresh must not discard all usable state when one secondary call fails | P2 | Keep dashboard refresh authoritative and surface scoped alerts/history errors separately |

## Guidance for Next Pass

Review the standalone bearer-session boundary, Host/Origin enforcement, token lifetime/storage, camera URL fetching and redirects, response-size enforcement, CSP, credential handling, redaction, and denial behavior. Pay particular attention to SSRF and unbounded camera bodies.
