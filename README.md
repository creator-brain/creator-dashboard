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

The deal drawer can read a linked Gmail thread, save a reply as a Gmail draft, and send a reply after confirmation. The Gmail link must be in that deal's Notion `Gmail Thread` property. Email text is displayed as plain text. Gmail account access uses OAuth; the server never puts Google tokens in the frontend bundle or stores them in Notion. A refresh token is kept in an encrypted, HTTP-only browser cookie. Disconnecting removes that cookie.

1. In [Google Cloud Console](https://console.cloud.google.com/), create or select a project and enable the **Gmail API**.
2. Under **Google Auth platform**, configure **Branding** and **Audience**. For a personal Gmail account, choose **External**, add your own Google account as a test user, and add the `gmail.readonly` and `gmail.compose` scopes under **Data Access**. The latter permits drafts and sending. Google classifies both scopes as restricted, so an external production app may require verification; test-mode refresh tokens may expire after seven days.
3. Under **Clients**, create an OAuth client of type **Web application**. Add this exact authorized redirect URI: `https://collab-pipeline.vercel.app/api/gmail/auth/callback`. For local testing, also add `http://127.0.0.1:3001/api/gmail/auth/callback`.
4. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` as sensitive Vercel environment variables. Generate a 32-byte cookie key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and set it as sensitive `GMAIL_COOKIE_KEY`. Set `GMAIL_REDIRECT_URI` to the production redirect URI above. Redeploy so the variables reach the function.
5. Open a deal with a linked Gmail thread and click **Connect Gmail**. Select the Google account whose mailbox contains that thread. The connection belongs to that browser; repeat sign-in in another browser.

For local testing, put the same client ID, secret and cookie key in `.env`, with the local redirect URI and `GMAIL_APP_ORIGIN` from `.env.example`. Do not commit these values.

## Data and security

Notion remains the only deal store. Browser `localStorage` keeps only display preferences. The token never enters the frontend bundle. The server limits reads and writes to the configured data source and validates property updates. It stamps `Last Activity` on every edit. Deal page content is rendered as escaped Markdown; HTML from Notion is not executed.

The old `collab-pipeline.html` is retained as the previously published Claude Artifact. The React app starts from `index.html` and does not need the Artifact runtime.

Typing in search shows matching suggestions and replaces the board with a single vertical results list. It searches both deal tabs and the archive, and shows an explicit zero-match state. Clearing the field returns to the board.

### Follow up column

On both tabs, an **Awaiting brand** deal moves to **Follow up · 14+ days** when its Notion **Last Edited** time is at least 14 days old. The server rechecks each candidate page, then writes the real Notion `Status` option **Follow up - 14+ days** and stamps `Last Activity`. A failed write leaves the deal in Awaiting brand and appears as a warning in the app. The server checks every 15 minutes while running; opening or refreshing the board also checks. The first successful move adds the select option to the Notion data source if the integration has permission to update it.
