# Collab Pipeline

React dashboard for the **💌 Collab Tracker** Notion database. Vite serves the interface; a small Express server holds the Notion token and calls the Notion API. Tailwind CSS and daisyUI style the UI, and Lucide supplies icons (daisyUI does not include an icon set).

## Run locally

1. Use either a Notion **personal access token (PAT)** with the Notion API capability, or an internal connection API token with **Read content** and **Update content** capabilities.
2. The token must have access to the **💌 Collab Tracker** database. For an internal connection, add it to that database in Notion. Use the database named in `AGENTS.md`, not the older legacy database.
3. Copy `.env.example` to `.env` and set `NOTION_TOKEN`. `.env` is ignored by Git.
4. Run:

   ```bash
   npm install
   npm run dev
   ```

Open <http://127.0.0.1:5173>. The API runs at <http://127.0.0.1:3001>. The server binds to localhost; keep it behind authentication if you expose it beyond your computer.

Run `npm run build` for a production build, then `npm start` to serve the built app and API from port 3001.

## Vercel

The Vite app deploys from `dist`, and `api/index.js` runs the Notion API as a Vercel Function. Set `NOTION_TOKEN` as a sensitive server-side environment variable. Keep Vercel Authentication enabled for **all deployments** because the board contains private collaboration details. On Vercel, follow-up checks run when the board requests deals; the local server also checks every 15 minutes while it is running.

The Vercel project is `maguireongs-projects/collab-pipeline`. Its production URL is <https://collab-pipeline.vercel.app>. `.env`, `.env.local`, and `.vercel` are ignored by Git; `.vercelignore` excludes local secrets from uploads.

## Connect Gmail

Open **Integrations** below the Collab Pipeline name in the sidebar, or from the top bar on smaller screens, to connect or disconnect Gmail. The same panel connects or disconnects Instagram after the server is configured.

The Gmail conversation section appears only for deals with an **Email** source pill. The pill comes from that deal's Notion `Gmail Thread` property. Add a Gmail URL there to link a deal that does not yet have an Email pill; linked deals can change their conversation link in the drawer. The server checks that the connected Gmail account can read a newly linked conversation before saving it. Existing `thread-f:` Gmail links are supported. Opening the deal retrieves the full conversation with the newest non-draft message open, fills the reply recipient and subject, and sends or saves drafts in the same thread. Each message shows its newly written text without the quoted chain from earlier replies. Email text is displayed as plain text. Gmail account access uses OAuth; the server never puts Google tokens in the frontend bundle or stores them in Notion. A refresh token is kept in an encrypted, HTTP-only browser cookie. Disconnecting removes that cookie.

The reply editor includes starting templates for requesting details, sharing a rate, following up, submitting a draft, checking payment, and declining. Selecting a template fills only the local editor. Review bracketed details and the recipient before choosing **Save draft** to store it in Gmail.

The **Attachments** dropdown accepts files by picker or drag and drop, lists them for removal, and includes them in one saved draft or sent reply. Files stay in browser memory until that action; they are not stored in Notion. Each message can have up to 10 files and 2.5 MB total, with no thread-wide file count. For larger PR kits, use Gmail directly or share a link.

The **Saved media kit** control stores one reusable file in this browser's IndexedDB. On any Email deal, choose **Attach saved media kit** in the Attachments dropdown to add it to that reply. The kit is never attached automatically. Browser storage is specific to the site origin and device, so a local copy does not carry over to the Vercel URL or another browser; choose the kit once on each origin where you want it available. The PDF is not in the repository or Notion.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable the **Gmail API**.
2. Under **Google Auth platform**, configure **Branding** and **Audience**. For a personal Gmail account, choose **External**, add your own Google account as a test user, and add the `gmail.readonly` and `gmail.compose` scopes under **Data Access**. The latter permits drafts and sending. Google classifies both scopes as restricted, so an external production app may require verification; test-mode refresh tokens may expire after seven days.
3. Under **Clients**, create an OAuth client of type **Web application**. Add this exact authorized redirect URI: `https://collab-pipeline.vercel.app/api/gmail/auth/callback`. For local testing, also add `http://127.0.0.1:3001/api/gmail/auth/callback`.
4. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` as sensitive Vercel environment variables. Generate a 32-byte cookie key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and set it as sensitive `GMAIL_COOKIE_KEY`. Set `GMAIL_REDIRECT_URI` to the production redirect URI above. Redeploy so the variables reach the function.
5. Open a deal with a linked Gmail thread and click **Connect Gmail**. Select the Google account whose mailbox contains that thread. The connection belongs to that browser; repeat sign-in in another browser.

For local testing, put the same client ID, secret and cookie key in `.env`, with the local redirect URI and `GMAIL_APP_ORIGIN` from `.env.example`. Do not commit these values.

## Instagram setup

1. Add a **Text** property named **Instagram Conversation ID** to the Collab Tracker data source. The automation puts each Instagram deal's handle in **Contact** and marks its source via **Agency / Platform**.
2. Generate a Meta access token for your Instagram professional account using your Unified Login setup, with `instagram_basic` and `instagram_manage_messages`. In local `.env` or Vercel Production, set `META_IG_ACCOUNT_ID` to that account ID and `META_ACCESS_TOKEN` to the token. Use a sensitive server environment variable in Vercel. The dashboard uses that one account for every Instagram deal.
3. Generate an inbox key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and save it as `META_INBOX_KEY`. Keep it in your password manager so you can enter it in the dashboard, and mark it as sensitive in Vercel. Use a different key for local development and production.
4. Redeploy after setting the Vercel variables. Open **Integrations → Unlock Instagram inbox** and enter the inbox key. The browser receives a signed cookie valid for up to seven days. The Meta token stays on the server. **Lock Instagram inbox** clears this browser's cookie. Rotating the inbox key or Meta token invalidates existing cookies.
5. The dashboard checks the connected inbox for Instagram deals with a handle and no saved conversation ID. It saves unique exact matches. Open a deal to view recent DMs. Use the conversation picker for deals that need manual linking.

**Webhook verification** uses a separate URL, `https://collab-pipeline.vercel.app/api/meta/webhook`, with the exact `META_WEBHOOK_VERIFY_TOKEN` value configured on the server. Reading linked conversations uses the Graph API on demand. Keep the messages webhook subscription off for now because background event processing has not been implemented.
