# Smart Sales CRM

Sales & customer-service CRM being evolved into a multi-tenant SaaS platform.

## Quick start (legacy server)

```bash
cp .env.example .env
npm install
npm run create-admin -- <username> "<Full Name>"   # prompts for a password (min 8 chars)
npm start                                          # http://localhost:3000
```

There is **no default account**. Runtime data (`data/`) and uploads are git-ignored.

## Tests

```bash
npm test
```

## Security notes

- All `/api` routes require a session (httpOnly cookie) and a CSRF token for writes; manager-only routes are enforced server-side.
- Meta webhooks are rejected unless `META_APP_SECRET` is set (signatures are verified over the raw request body).
- Secrets should be supplied via environment variables; they are never returned to the browser.
