# Smart Sales CRM — UI/UX redesign report

## 1. Audit (before the redesign)

**Architecture.** One Node 22 / Express 5 service that serves both the JSON API (`/api/*`) and the
built React SPA (`web/`, Vite). PostgreSQL 16 with knex migrations. Multi-tenancy is enforced in the
database: every tenant table has `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy, and the
app connects with a role that cannot bypass it (`db.withContext({ companyId, userId })`).
Permissions are checked per route (`requirePermission`) from role permissions stored per company.
Background jobs use pg-boss. Messaging channels: Telegram, Messenger, Instagram, WhatsApp (adapters).

**Modules.** Auth (company + separate Super Admin console), dashboard, inbox, channels, customers,
sales pipeline, orders, tasks, reports, team, roles & permissions, company settings & branding,
billing/subscription, activity log, account; Super Admin: overview, companies, registrations, plans,
channels, platform branding.

**Design layer.** A single token-based stylesheet (`web/src/styles.css`) with light/dark themes and
runtime branding (primary/secondary/accent colors and font injected from platform/company settings).
Shared UI components in `web/src/components/ui.jsx` and `components/crm.jsx`. RTL/LTR via logical
CSS properties and i18next (Arabic/English, parity enforced by tests).

**Bugs found and fixed**
| # | Problem | Fix |
|---|---------|-----|
| 1 | Phase-4 routes (customers, pipeline, orders, tasks, reports) were also inserted inside the Super Admin route tree, where `page()` is not defined → the Super Admin console crashed after login. | Removed the duplicated routes from the admin tree. |
| 2 | Customers created before the `source` column existed had no source, so "customer sources" would show them as manual. | Migration back-fills `source` from each customer's first channel identity. |
| 3 | Bar charts were mirrored in Arabic (time ran right→left, inconsistent with the dashboard). | Time axes always run left→right in both languages. |
| 4 | Money in Arabic rendered as "US$" / "$US". | Currency formatted with the narrow symbol ("$4,200"). |
| 5 | Pages used `overflow-x: hidden` on `html/body`, turning the body into a scroll container (breaks sticky headers and full-page capture). | `overflow-x: clip`. |
| 6 | Top-bar search did not exist; customer search could not be deep-linked. | Global search → `/customers?search=…`, read from the URL. |

## 2. Design system
- Dark navy default theme (`#071026` background, deep-blue surfaces, electric-blue primary `#2563eb`),
  light theme kept and refreshed; both driven by the same tokens.
- Data palette: blue, cyan, green, purple, orange, pink (`--c-*`).
- Rounded 16px cards with subtle gradients and shadows; gradient primary buttons; active nav item
  with a blue gradient and glow; micro-interactions (hover lift, fade-in, shimmer skeletons).
- New reusable components: `AreaChart` (responsive, hover tooltip), `Sparkline`, `Donut`, `Trend`,
  `timeAgo`, KPI card, activity feed.
- Branding: "Smart Sales CRM — by WASL Technologies v1.0" in the sidebar; logo, colors and font remain
  editable in Super Admin → Platform settings. The migration switches the platform default theme to
  dark and the primary color to electric blue **only if they were still on the original defaults**.

## 3. Dashboard (`GET /api/dashboard?days=30|90|365`)
All figures are computed from the company's data; each block appears only with the permission that
already guards that data:

| Block | Source | Permission |
|-------|--------|-----------|
| Total customers (+ new vs previous period, sparkline) | contacts | customers.view / manage |
| Total sales (period, trend, chart) | orders (not cancelled) | reports.financial |
| New conversations | conversations | conversations.view_all or reports.view |
| Conversion rate | % of customers first seen in the period who became paying customers | customers.view / manage |
| Customer sources | contacts by source | customers.view / manage |
| Top customers | orders by customer | reports.financial |
| Recent activity | customers, closed deals, orders, conversations | per event type (amounts only with reports.financial) |
| Upcoming tasks | own open tasks | everyone |

Year view is bucketed by month; 30/90 days by day. Trends compare with the previous period of equal length.

## 4. Verification
- Automated: full server + frontend test suite (auth, permissions, tenant isolation/RLS, migrations
  up/down, messaging, CRM, dashboard permission scoping, translation parity).
- Visual: every workspace page and every Super Admin page captured in Arabic and English, desktop
  and mobile; no runtime errors and no horizontal overflow.

## 5. Deployment
Uses the existing server process unchanged (build on the server, migrations, systemd restart, health
check with automatic rollback to the previous release). The server script now takes a **verified
database backup before migrations** and aborts without changes if the backup fails.
