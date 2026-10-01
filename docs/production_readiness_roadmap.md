# Production Readiness Roadmap

Updated October 1, 2026 after the pre-shipping review and remediation.

## Release verdict

The four reproduced P1 issues and three listed P2 issues have code fixes and regression coverage. Local checks and the mocked standalone browser workflow pass. Real-account/device behavior and actual MCP host iframe rendering remain external validation gates; local success does not establish real-device readiness.

## Remediated issues

| Priority | Finding | Result |
| --- | --- | --- |
| P1 | Timed-out physical commands could complete after subsequent commands | Any transport failure after write dispatch returns `uncertain` and disables further writes for the server session, including already prepared commands. The upstream operation is not cancelled and may still complete. |
| P1 | Verification failures were recorded as failed physical actions | Accepted commands remain `submitted` with a verification warning. Partial thermostat writes become uncertain. Audit and MCP result schemas preserve these outcomes. |
| P1 | Unknown/multiple panels produced misleading system status | System reports armed, disarmed, mixed, or unknown; `armed` is nullable for unknown/mixed state. All panels have explicitly targeted controls. Unknown state raises warning health and alerts. |
| P1 | Missing upstream expiry prevented authentication caching | Five-minute cache independent of upstream expiry, coalesced login, one authentication refresh for expired reads, no automatic write retries. |
| P2 | Failed audit append poisoned later history reads | Failed writes remain visible to their callers without poisoning the queue barrier for future reads or writes. |
| P2 | Expired tab sessions ignored fresh browser links | Fresh bootstrap takes precedence, expired tokens are evicted on 401, failed exchange promises are cleared, and new links work in the same tab. No action retry is automatic. |
| P2 | DNS validation was separate from snapshot connection | Native HTTPS connects to a validated IP directly; original Host/SNI/certificate hostname are retained. Redirects receive separately validated destinations; deadline includes DNS and stalled body reads. |

Initial alert rendering now derives alerts from the received dashboard, including host-delivered initial results. Compatible lockfile updates remediate all seven dependency advisories reported in the review.

## Validation

- Strict TypeScript checking passes.
- Source suite: 40 passing tests, including late completion, queued-write denial, partial thermostat changes, verification failure, upstream-shaped auth, unknown/mixed/missing panels, audit repair, fresh session links, pinned IP/TLS hostname, redirect validation, and DNS/body deadlines.
- Compiled stdio/standalone negotiation and mutation smoke: one passing test.
- Clean production build and package-content dry run pass.
- Full dependency audit and production-only audit report zero vulnerabilities. A transient audit endpoint error was retried successfully using a writable temporary cache.
- Built UI in Edge with injected mock APIs: mixed states and both panels visible; Garage action targets `panel-2` independently; delayed lock action shows `uncertain`, records that history, and disables every control; a fresh link works in the same tab. No real credentials or hardware were used.
- The user's `ADT Home Security` heading is preserved.

## Remaining gates

- Supervised real-account read-only validation with representative panels, locks, thermostats, and camera CDN responses.
- Actual supported MCP host iframe, initial-result delivery, fullscreen, and open-link validation.
- Clean production-only installation of the published package candidate.

An uncertain command can outlive this process. Reconcile its outcome and ensure no command remains pending in ADT before restarting. Restarting solely to clear the control block is unsafe.
