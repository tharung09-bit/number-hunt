# Free hosting: Render (game server) + Neon (database)

1. **GitHub**: create a repository and upload this whole folder (not node_modules). Keep package.json at the top level.
2. **Neon** (neon.com, free): create a project, copy the connection string (starts with postgresql://).
3. **Render** (render.com, free): New > Blueprint > pick the repository. When asked, paste the Neon string into DATABASE_URL.
4. Open the https://number-hunt-xxxx.onrender.com address Render shows and share it.
5. Optional, stops the 15-minute sleep: a free uptime monitor (for example UptimeRobot) that requests
   https://YOUR-APP.onrender.com/health every 5 minutes.
6. Optional Google sign-in: add the Render address under Authorised JavaScript origins in Google Cloud Console,
   then set GOOGLE_CLIENT_ID in Render > Environment.

Free-tier limits (checked Nov 2026, they can change): Render free web services sleep after 15 minutes without traffic
(about 1 minute to wake), get 750 instance hours per month and have no persistent disk. Neon free keeps 1 GB per project and
its compute sleeps after 5 minutes idle (the first request after that is a little slower; data is kept).
Rooms live in memory, so a restart or redeploy ends running matches.
