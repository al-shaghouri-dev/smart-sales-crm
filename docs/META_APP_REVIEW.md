# Meta App Review — preparation pack

Everything the code needs is implemented. What remains is done by the business owner in Meta's
dashboards. **No request has been submitted and no terms were accepted on the owner's behalf.**

## 1. Accounts and app (owner)

1. A Meta Business portfolio (business.facebook.com) for the platform company, with **Business Verification** completed.
2. A Meta developer app of type **Business**, owned by that portfolio.
3. Products to add: **Messenger**, **Instagram** (API setup with Instagram Login), **WhatsApp**, **Facebook Login for Business**, **Webhooks**.
4. Public pages required in App Settings → Basic:
   - Privacy Policy URL (must describe what data is processed: messages, contact names/IDs, attachments, retention, deletion);
   - Terms of Service URL;
   - User data deletion: callback `PUBLIC_URL/api/public/meta/messenger/data-deletion` (implemented; returns a status URL).
   The legal texts must be written/approved by the owner (not generated here).
5. App icon (1024×1024) and the app's category.

## 2. Configuration values → environment

| Meta dashboard | Environment variable |
|---|---|
| App ID / App Secret (Settings → Basic) | `META_APP_ID`, `META_APP_SECRET` |
| Instagram app ID / secret (Instagram → API setup with Instagram Login) | `META_IG_APP_ID`, `META_IG_APP_SECRET` |
| Webhook verify token (choose any random string) | `META_VERIFY_TOKEN` (Render generates one) |
| Graph API version | `META_GRAPH_VERSION` (default `v24.0`) |
| WhatsApp Embedded Signup configuration ID (Tech Provider only) | `META_WA_CONFIG_ID` (leave empty until approved) |

Then add the channel names to `CHANNEL_PROVIDERS` and redeploy. Callback/redirect URLs: see `docs/DEPLOYMENT.md` §10.2.

## 3. Permissions to request and how the app uses them

| Permission | Product | Used for (as implemented) | Screencast should show |
|---|---|---|---|
| `pages_show_list` | Messenger | listing the Pages the admin can connect | Channels → Connect Messenger → Facebook login → Page picker |
| `pages_messaging` | Messenger | receiving and replying to Page conversations in the inbox | customer writes to the Page → appears in inbox → agent replies → arrives in Messenger |
| `pages_manage_metadata` | Messenger | subscribing the app to the Page's webhooks | connection succeeds; webhooks deliver |
| `business_management` | Messenger | Pages owned by a Business portfolio | (only if those Pages must be listed) |
| `instagram_business_basic` | Instagram | identifying the connected professional account | Connect Instagram → Instagram login → account appears |
| `instagram_business_manage_messages` | Instagram | receiving/replying to Instagram DMs | DM → inbox → reply → arrives in Instagram |
| `whatsapp_business_messaging` | WhatsApp | sending/receiving WhatsApp messages | customer message → inbox → reply/template |
| `whatsapp_business_management` | WhatsApp | subscribing to the WABA, listing approved templates | templates list, template send outside 24 h |

Request **Advanced Access** for each, with a test user and step-by-step reviewer instructions
(reviewer account on the CRM with a company that has the channel connected).

## 4. Policies the code already enforces

- Standard messaging only inside the **24-hour window** after the customer's last message (Messenger,
  Instagram, WhatsApp). Outside it the composer is disabled; WhatsApp can only send **approved templates**.
  Message tags / Human Agent are not used (postponed by decision).
- Webhook payloads are verified with `X-Hub-Signature-256` over the raw body before being stored.
- Tokens are encrypted at rest (AES-256-GCM, per-channel context) and never returned by the API or logged.
- **Deauthorize** callback flags the affected channels and deletes their tokens; **Data Deletion**
  callback disconnects them, deletes tokens and returns a confirmation code + status page.
- Instagram long-lived tokens are refreshed automatically before expiry; failures alert the company.
- Customers' data stays inside the company's tenant (PostgreSQL Row Level Security).

## 5. WhatsApp specifics

- **Now (no Tech Provider):** businesses that already have a WhatsApp Business Account connect with
  Phone number ID + WABA ID + a permanent **System User** token (Channels → WhatsApp).
- **Later (Tech Provider, owner's decision):** enable Embedded Signup by setting `META_WA_CONFIG_ID`;
  the endpoint `POST /api/channels/whatsapp/embedded-signup` is implemented and stays disabled until then.
  Embedded Signup v2 is deprecated on 15 Oct 2026 — configure **v4**. The front-end launcher (Facebook
  JS SDK) also needs `connect.facebook.net` added to the Content-Security-Policy at that time.
- Messaging limits / quality rating are shown by the connection test (`whatsapp.quality_low`).

## 6. Before submitting

- [ ] Business Verification approved.
- [ ] Privacy Policy, Terms and Data Deletion URLs public and reachable.
- [ ] Production deployment on HTTPS with the callbacks above verified (green "Verify and save").
- [ ] Screencasts recorded for every permission (English UI or captions).
- [ ] Reviewer test credentials prepared (a CRM user + Facebook/Instagram test accounts).
