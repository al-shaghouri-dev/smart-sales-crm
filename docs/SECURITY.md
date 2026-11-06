# Security review (Phase 3.8)

Scope: the multi-tenant server (`server/`), web app (`web/src`), migrations and scripts, as of the
Phase 3.8 commit. Method: code review against the OWASP Top 10 (2021) and OWASP API Top 10 (2023),
automated tests for every control listed, dependency and secret scans, a local load test and a
backup/restore + key-rotation drill.

## Results by category

| Area | Control in place | Evidence |
|---|---|---|
| A01 Broken access control / API1 BOLA | Every tenant table uses **FORCE ROW LEVEL SECURITY**; the app role has **NOBYPASSRLS**; tenant context is set per transaction (`SET LOCAL`). Conversations are additionally scoped by `view_all` / `view_assigned`; hidden rows answer 404. Super Admin APIs need a separate platform session. | `foundation`, `phase2`, `phase3-2` tests: cross-company reads/writes/downloads all 404; DB-level inserts into another tenant rejected; `prepare-database.js` refuses SUPERUSER/BYPASSRLS roles. |
| API5 Function-level authorisation | Permission middleware on every route (`channels.manage`, `conversations.reply`, `conversations.assign`, …). | Employee/supervisor tests in `phase3-2`, `phase3-7`. |
| A02 Cryptographic failures | Channel credentials and OAuth sessions: AES-256-GCM, key ring with versions, AAD binding to purpose/company/channel. Passwords: scrypt. Session tokens stored as SHA-256 hashes. Webhook secrets derived per channel with HMAC. | `secrets` unit tests; rotation drill on a restored DB (rotate → 0 remaining → decrypt with new key only). |
| A03 Injection | Knex parameter binding throughout; no string-built SQL with user input (grep verified); search `ILIKE` escapes `%`/`_`. React escapes output; no `dangerouslySetInnerHTML`. | Code grep; validation tests. |
| A04 Insecure design | Persist-then-acknowledge webhooks, idempotency keys, outbound "unknown outcome" never re-sent, per-company kill switch and daily cap, plan limits under advisory locks. | Concurrency tests (seats, channels, first-message race). |
| A05 Misconfiguration | Helmet (CSP, HSTS in production, frame-ancestors none, nosniff, referrer no-referrer), `x-powered-by` off, production refuses the fake provider, missing keys, non-https `PUBLIC_URL`. Attachments served with `nosniff` + sandbox CSP, non-images as downloads. | `phase3-8-security` header tests; config tests. |
| A06 Vulnerable components | `npm audit`: **0** vulnerabilities (uuid pinned to 11.1.1 for exceljs). | `npm audit` output in the Phase 3.8 report. |
| A07 Identification & authentication | Rate-limited login and recovery, uniform errors, session revocation on password change, CSRF token on every write (checked for every new endpoint in `phase3-8-security`), `SameSite=Lax` httpOnly cookies, Socket.IO uses the same session check + origin/Sec-Fetch-Site validation. | `foundation`, `phase3-infra` tests. |
| A08 Integrity | Webhooks verified on raw bytes (HMAC-SHA256 / Telegram secret token / Meta signed_request) before storage; OAuth `state` signed and bound to a browser cookie and to the user. | `phase3-3`, `phase3-4` tests (forged signatures, foreign channel secret, forged callback). |
| A09 Logging | Audit log for security-relevant actions (channel connect/disconnect, assignments, outbound controls); secrets scrubbed; URLs redacted; provider errors stored as codes. | Audit tests; `redact` tests. |
| A10 SSRF | All outbound HTTP via `safeFetch`: https only, DNS-resolved private/loopback/link-local/metadata ranges refused, connection pinned to the vetted IPs (DNS rebinding), host allow-lists for Meta CDNs, re-validated redirects without credentials, size limits and timeouts. | `phase3-3` SSRF tests. |
| API4 Resource consumption | `/api` rate limit (configurable), webhook rate limit, body size limits, upload size limits, Socket.IO payload limit, batch caps in parsers. | Load test: 606 webhooks/s with p95 147 ms, no errors. |

## Residual risks and recommendations

1. **Real provider tests are pending** (no bot token / Meta app in this environment). The adapters are
   verified against faithful mock servers only; run the live checklist in the final report before launch.
2. **Legal pages** (privacy policy, terms) must be written and approved by the owner before Meta review.
3. **Single region / single instance**: fine for launch. For high availability run several `web`
   instances with `REALTIME_ADAPTER=postgres` and a separate `worker` (see §9 of DEPLOYMENT.md).
4. **Encryption key custody**: keys live only in the host's environment; keep an offline copy.
5. **Email**: without SMTP, invitation/reset links are shown once to the admin — configure SMTP for production.
6. Consider adding 2FA for Super Admin accounts in a later phase.
