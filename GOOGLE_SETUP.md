# Real Google sign-in: setup (about 5 minutes)

The code is already in place. The only missing piece is a Google OAuth Client ID, which only you can create.

1. Open https://console.cloud.google.com/ and create (or pick) a project.
2. APIs & Services > OAuth consent screen: choose External, fill in app name and your email, save.
   (While in "Testing", add your Gmail address under Test users. Click "Publish app" to let anyone sign in.)
3. APIs & Services > Credentials > Create credentials > OAuth client ID > **Web application**.
4. Under **Authorised JavaScript origins** add every address the game is opened from:
   - `http://localhost:3000`   (local testing)
   - `https://your-app.onrender.com`   (your deployed URL, exactly, no trailing slash)
   Leave "Authorised redirect URIs" empty (Google's button does not use one).
5. Copy the Client ID (ends in `.apps.googleusercontent.com`).
6. Local: copy `.env.example` to `.env`, paste the ID after `GOOGLE_CLIENT_ID=`, then `npm install && npm start`.
   Render: Dashboard > your service > Environment > set `GOOGLE_CLIENT_ID`, then redeploy.
7. Open the site, click Google. You should see Google's real button, not the "demo accounts" list.

How it works: the page fetches the Client ID from `/config`, Google's button returns a signed ID token,
the page POSTs it to `/api/google`, the server verifies it with Google's public keys (audience = your Client ID),
creates or finds the account (matched by Google ID, or by a Google-verified email), and returns a signed session token.

Tip: set a fixed `SESSION_SECRET`, otherwise everyone is signed out on every restart.
