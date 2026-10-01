# Review Pass 3 Summary: Security and Data Protection

## Overview

Credentials remain environment-only, mutations fail closed in real mode, confirmation tokens are random/expiring/action-bound, production dependencies currently have no known vulnerabilities, and the standalone server binds only to loopback with exact Host/Origin checks. Two camera-download weaknesses and one browser-session exposure should be remediated before calling the surface complete.

## Checklist Completion

- [x] Input validation: MCP schemas and HTTP JSON/body/ID limits reject malformed input.
- [x] Secret management: no hardcoded production credentials or credential logging was found.
- [x] Least privilege: real mutations are disabled by default; browser API exposes only dashboard workflows.
- [x] Cryptography: session and confirmation tokens use 256-bit CSPRNG values; action binding uses SHA-256 plus timing-safe comparison.
- [ ] Outbound media safety: camera redirects and response bodies need stronger validation and streaming bounds.

## Key Findings

| Category | Issue | Severity | Recommendation |
| :--- | :--- | :--- | :--- |
| SSRF | Camera snapshot uses unrestricted `redirect: "follow"` on a provider-returned URL | P0 | Require HTTPS, reject credentials/private or local hosts, validate every redirect, and cap redirect count |
| Resource exhaustion | Snapshot without a trustworthy `Content-Length` is fully buffered before the 5 MB check | P0 | Stream into bounded chunks and cancel immediately above 5 MB |
| Session exposure | The bearer token in the returned pop-out URL remains usable for the full one-hour browser session | P1 | Return a two-minute, one-use bootstrap token and exchange it for a browser-only session token |
| HTTP boundary | Host rejection exists but has no raw-request regression test | P1 | Test a hostile `Host` with `node:http`, since `fetch` cannot reliably override it |
| Dependencies | Production audit reports zero known vulnerabilities | Pass | Retain `npm audit --omit=dev` in release verification |
| Browser hardening | Exact Origin, bearer auth, no CORS, CSP, frame denial, no-store, and restrictive permissions are present | Pass | Preserve these controls while adding endpoints |

## Guidance for Next Pass

Measure redundant provider calls, bound alert/history/session collections, inspect audit-file reads and rotation, avoid duplicated refresh traffic, ensure snapshot redirect/stream limits are total-operation bounds, and add appropriate concurrency controls for browser actions.
