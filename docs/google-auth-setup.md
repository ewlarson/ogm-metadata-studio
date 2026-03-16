# Google authentication setup

Aardvark Metadata Studio can require sign-in with Google for mutating actions (add/edit resources, import, export). Viewing and search remain available without signing in.

## 1. Create a Google Cloud OAuth client

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Open **APIs & Services** → **Credentials**.
4. Click **Create credentials** → **OAuth client ID**.
5. If prompted, configure the OAuth consent screen (e.g. External, app name, support email).
6. Choose application type **Web application**.
7. Under **Authorized JavaScript origins**, add:
   - `http://localhost:5173` (local dev)
   - Your production origin (e.g. `https://your-app.vercel.app` or GitHub Pages URL).
8. You do **not** need to add Authorized redirect URIs for the Google Identity Services (GIS) flow used here.
9. Create the client and copy the **Client ID** (e.g. `123...apps.googleusercontent.com`).

## 2. Configure the app

1. In the repo, copy the example env file:
   ```bash
   cp web/.env.example web/.env
   ```
2. Edit `web/.env` and set (no quotes, no spaces around `=`):
   ```
   VITE_GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
   ```
3. (Optional) Restrict which Google accounts can sign in:
   - To allow **only specific email addresses**, set:
     ```
     VITE_GOOGLE_ALLOWED_EMAILS=alice@example.com,bob@example.com
     ```
   - The value is parsed as a comma/space-separated list; emails are compared case-insensitively.
   - If `VITE_GOOGLE_ALLOWED_EMAILS` is not set or left blank, the app defaults to allowing only `ewlarson@gmail.com`.
4. Restart the dev server so Vite picks up the new variables. Vite loads `web/.env` from the directory that contains `vite.config.ts` (see `envDir` in that config).

Without a valid `VITE_GOOGLE_CLIENT_ID`, the app still runs; you'll see a message to set it and a Sign in control.

## 3. Troubleshooting

- **Run the app from the `web/` directory:** From the repo root, run `cd web && npm run dev` (there is no `dev` script at the project root).
- **Sign-in UI not visible:** When not signed in, an indigo banner appears at the top of the main content: "Sign in with Google to add, edit, or import data" with a button. There is also a "Sign in with Google" control in the header (right side, next to the theme toggle).
- **Still seeing old UI:** Stop the dev server, clear Vite's cache, then restart and hard-refresh the browser:
  ```bash
  cd web && rm -rf node_modules/.vite && npm run dev
  ```
  Then in the browser: **Cmd+Shift+R** (Mac) or **Ctrl+Shift+R** (Windows/Linux).
