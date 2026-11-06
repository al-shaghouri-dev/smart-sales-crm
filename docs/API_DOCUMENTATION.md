# API documentation

Base path: `/api` on the same origin as the web app. JSON requests and responses (multipart for uploads).

## Conventions

- **Authentication:** cookie session. `POST /api/auth/login` (workspace) or `POST /api/auth/platform-login`
  (Super Admin) sets the httpOnly cookie `sscrm_session` (`SameSite=Lax`, `Secure` in production).
- **CSRF:** every non-GET request needs header `X-CSRF-Token: <csrfToken>` where `csrfToken` is returned
  by `GET /api/auth/me`.
- **Tenant:** a workspace session belongs to one company; switch with `POST /api/auth/switch-company`.
- **Errors:** `{ "ok": false, "code": "area.reason", "error": "English fallback", "details": { "field": … } }`.
  Status codes: 400 validation, 401 not signed in, 402 subscription inactive (read-only/blocked policy),
  403 forbidden / CSRF / plan, 404 not found or not visible, 409 conflict/limit, 429 rate limited, 5xx server.
- **Rate limits:** `/api` per IP (`API_RATE_LIMIT_PER_MINUTE`), stricter on login/recovery/registration/tokens.
- **Permissions** (role-based, per company): `company.settings.view|manage`, `company.branding.manage`,
  `billing.view`, `users.view|manage`, `roles.manage`, `shifts.manage`, `conversations.view_all|view_assigned|reply|assign`,
  `customers.view|manage|export`, `orders.view|manage|export`, `reports.view|financial`, `channels.manage`, `audit.view`.

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/health` | none | `{ ok: true, service }` — liveness |
| GET | `/api/ready` | none | `200 { ok, checks: { database, jobs, accepting } }` or `503` — readiness |

## Public (no session)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/public/branding` | platform name, logo, colors, registration flag |
| GET | `/api/public/plans` | public active plans |
| POST | `/api/public/register` | self-registration request `{ companyName, ownerName, ownerEmail, ownerPhone, businessType?, country?, companyPhone?, planId? }` — reviewed by the Super Admin; returns 403 `registration.closed` when disabled |
| POST | `/api/public/meta/:provider/deauthorize` | Meta callback, form field `signed_request` |
| POST | `/api/public/meta/:provider/data-deletion` | Meta callback → `{ url, confirmation_code }` |
| GET | `/api/public/meta/deletion-status/:code` | HTML status page |

## Authentication & account

| Method | Path | Body / notes |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }` |
| POST | `/api/auth/platform-login` | `{ email, password }` — Super Admin console session |
| GET | `/api/auth/me` | current user, company, membership, permissions, subscription, `csrfToken` |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/switch-company` | `{ companyId }` |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` (signs out other sessions) |
| POST | `/api/auth/forgot-password` | `{ email }` — always 200 |
| POST | `/api/auth/token/inspect` | `{ token }` — invitation/reset link details |
| POST | `/api/auth/token/accept` | `{ token, password, name? }` |
| PATCH | `/api/me` | `{ name?, phone? }` |
| PATCH | `/api/me/preferences` | `{ locale?: ar\|en\|null, theme?: light\|dark\|system\|null }` |

## Company workspace

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/company` | company.settings.view/manage | profile, settings, branding |
| PATCH | `/api/company` | company.settings.manage | profile + settings (incl. `quickReplies`) |
| PATCH | `/api/company/branding` | company.branding.manage + plan `branding.custom` | |
| POST | `/api/company/branding/logo` | same | multipart `file` (PNG/JPG/WEBP/GIF, 2 MB) |
| GET | `/api/team` | users.view/manage | members |
| POST | `/api/team` | users.manage | `{ name, email, roleId, phone?, jobTitle?, password? }` — no password ⇒ invitation link |
| PATCH | `/api/team/:id` | users.manage | role, status, profile |
| POST | `/api/team/:id/password` | users.manage | set password (accounts owned by this company only) |
| POST | `/api/team/:id/link` | users.manage | new invitation/reset link |
| DELETE | `/api/team/:id` | users.manage | remove membership |
| GET | `/api/roles` · `/api/roles/permissions` | users.view / roles.manage | |
| POST · PATCH · DELETE | `/api/roles[/:id]` | roles.manage | custom roles |
| GET | `/api/audit` | audit.view | activity log |
| GET | `/api/billing` | billing.view | subscription, usage, payments |
| GET | `/api/notifications` · POST `/api/notifications/read-all` · POST `/api/notifications/:id/read` | signed in | in-app notifications |

## Inbox

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/conversations` | view_all or view_assigned | query: `status=open\|pending\|closed\|all`, `search`, `assigned=me\|unassigned\|<membershipId>`, `channelId`, `priority`, `unread=true`, `cursor`, `limit` → `{ conversations, nextCursor, counts }` |
| GET | `/api/conversations/assignees` | conversations.assign | assignable members |
| GET | `/api/conversations/quick-replies` | inbox access | company quick replies |
| GET | `/api/conversations/:id` | visible | one conversation (incl. `replyWindow`) |
| GET | `/api/conversations/:id/messages` | visible | `before=<messageId>`, `limit` → `{ messages, hasMore }` |
| POST | `/api/conversations/:id/messages` | conversations.reply | JSON `{ text, clientMessageId? }`, multipart `text` + `file`, or `{ template: { name, language, params[] }, templatePreview }` (WhatsApp) → `201 { message }` (`200 duplicate` for a repeated `clientMessageId`) |
| POST | `/api/conversations/:id/messages/:messageId/retry` | conversations.reply | failed messages only |
| POST | `/api/conversations/:id/read` | visible | reset unread |
| PATCH | `/api/conversations/:id` | reply or assign | `{ status?, priority? }` |
| POST | `/api/conversations/:id/assign` | conversations.assign | `{ membershipId \| null, reason? }` |
| GET | `/api/conversations/:id/assignments` | visible | history |
| GET | `/api/conversations/:id/attachments/:attachmentId` | visible | file download (`nosniff`, sandbox CSP) |

Conversations not visible to the member answer **404**. Common message error codes:
`messages.window_closed`, `messages.channel_unavailable`, `messages.outbound_paused`, `messages.daily_limit` (429).

## Channels

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/channels` | channels.manage or inbox access | managers get status, errors, token expiry |
| GET | `/api/channels/providers` | channels.manage | enabled providers, plan allowance, usage |
| POST | `/api/channels/:provider/connect` | channels.manage | Telegram `{ token }`; WhatsApp `{ phoneNumberId, wabaId, accessToken }` |
| GET | `/api/channels/:provider/oauth/start` | channels.manage | browser redirect (Messenger, Instagram) |
| GET | `/api/channels/oauth/callback/:provider` | channels.manage | OAuth redirect target → `/channels?oauth=<id>` |
| GET | `/api/channels/oauth/sessions/:id` | channels.manage | accounts to choose (no tokens) |
| POST | `/api/channels/oauth/sessions/:id/connect` | channels.manage | `{ externalAccountId }` |
| POST | `/api/channels/whatsapp/embedded-signup` | channels.manage | disabled unless `META_WA_CONFIG_ID` |
| POST | `/api/channels/:id/test` | channels.manage | health check → `{ ok, code, channel }` |
| PATCH | `/api/channels/:id` | channels.manage | `{ displayName }` |
| DELETE | `/api/channels/:id` | channels.manage | disconnect (credentials deleted, history kept) |
| GET | `/api/channels/:id/templates` | reply or manage | approved WhatsApp templates |

## Super Admin (`/api/platform`, platform session only)

| Method | Path | Notes |
|---|---|---|
| GET · PATCH | `/settings` | platform branding/policies |
| POST | `/branding/:asset` | `logo` or `favicon` upload |
| GET | `/overview` | KPIs |
| GET · POST | `/companies` | list (`search`, `status`, `subscription`, `plan`) / create `{ name, owner: { name, email, phone? }, email?, phone?, country?, timezone?, currency?, defaultLocale?, status?, subscription? }` → `{ companyId, invitation }` |
| GET · PATCH | `/companies/:id` | details / profile |
| POST | `/companies/:id/activate` · `/suspend` `{ reason }` · `/reactivate` | status |
| POST | `/companies/:id/owner-link` · `/members/:memberId/link` | invitation/reset links |
| PUT · PATCH | `/companies/:id/subscription` | assign plan / change dates & status |
| POST | `/companies/:id/subscription/extend` · `/payments` | manual billing |
| GET · POST · PATCH · DELETE | `/plans[/:id]`, POST `/plans/templates` | plans (limits, features, allowed channel types) |
| GET | `/registrations` · POST `/:id/approve` · `/:id/reject` · `/:id/request-info` · PATCH `/:id` | self-registrations |
| GET | `/webhook-events` · POST `/:id/retry` | failed webhook review |
| GET | `/channels` | all channels (status, errors, 24h traffic, token expiry) |
| GET · PATCH | `/channels/outbound/:companyId` | `{ paused, dailyLimit }` kill switch / cap |

## Non-API HTTP endpoints

| Path | Purpose |
|---|---|
| `GET/POST /webhooks/:provider[/:key]` | provider webhooks (Telegram uses `/webhooks/telegram/<channelId>`) |
| `GET /media/:token` | short-lived signed attachment links (providers fetch by URL) |
| `GET /uploads/*` | public logos/favicons |
| `/socket.io` | Socket.IO (see ARCHITECTURE.md › Real-time) |
