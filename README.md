# Number Hunt - multiplayer server

Server-authoritative backend (Node.js, Express, Socket.IO). The server owns rooms, teams, the two
independent rotations (searcher and target selector), timers, target validation (0 to board size-1, each used once; the board has 150 to 1000 numbers, default 500),
click validation, scoring, board shuffling, bots, reconnects and the spectator delay.

## The styled client
`public/index.html` is the full styled Number Hunt page (intro, home, rooms, lobby, game, spectator, friends, settings).
When it is opened from this server it connects automatically and shows **Online multiplayer** (bottom-left badge).
Opened anywhere else it stays a local demo with bots (**Offline demo**). `public/simple.html` is a plain test client.

## Accounts
Register / sign in with email and password (scrypt hashes, signed 30-day tokens) or with Google. Accounts have a profile
(username, bio, avatar colour), stats and the last 20 matches, and a real friends system (requests, accept, search,
online / in-match status, room invites). Guests can still play without an account. Matches are saved for signed-in players
when they finish. Sign in via the page: email button > Create account.
Storage: Postgres when DATABASE_URL is set (production), otherwise a local SQLite file `data/numberhunt.db` (Node 22.13+).
Environment: SESSION_SECRET (set it, or everyone is signed out on every restart), DATABASE_URL, DB_FILE.
Not built yet: password recovery (needs an email provider), email verification, rate limiting beyond the sign-in routes.
The Postgres path uses the same SQL as the tested SQLite path but has not been run here.

## Player ID and profile pages
Every account gets a unique 9-digit Player ID (UID) when it is created; older accounts receive one automatically on the
next start. Anyone can open a player's public profile (GET /api/players/:uid): level, times played, wins, losses,
draws, win rate, accuracy, average find time and recent form. No email or private data is exposed. Friend requests
accept a UID or a username. In the page, clicking a player's name (friends, lobby, results, chat, game) opens that page.

## Game modes and board size
Team sizes 1v1 to 6v6. A room (private or quick match) chooses how many numbers are on the board:
150, 250, 350, 450, 500 (default), 750 or 1000 (numbers 0 to size-1). Quick match only pairs players who picked the
same team size and board size. Fewer numbers = faster rounds; more numbers = harder to find. The server validates
targets against the room's board size.

## Run
    npm install
    npm start            # http://localhost:3000   (open it in 2+ browser tabs)
    npm test             # game test (2 players + spectator + bots + chat) and accounts test (sign-up, friends, invites, history)

Environment variables:
- PORT                  default 3000
- SPECTATOR_DELAY_MS    default 3000 (anti-cheat delay for spectators)
- GOOGLE_CLIENT_ID      enables the `auth:google` event (verifies Google ID tokens on the server)

## What is implemented
- Private rooms with a code, 2v2 to 6v6, team switching, ready status, host controls, fill with bots.
- Quick match queue (waits 8 s, then fills the rest with bots).
- Match rules: target score, fixed rounds or match time; equal score = draw (no overtime).
- Wrong clicks cost nothing. Timeouts skip the round. Used targets are rejected.
- Live view: the searcher's scroll position and hovered tile are relayed to teammates, opponents and spectators.
- Spectators: read-only, receive everything after SPECTATOR_DELAY_MS.
- Disconnect: a bot takes the seat; on reconnect (`room:rejoin`) control returns at the next round.
- Text chat, results with MVP and per-player stats.

## Not done yet (next milestones)
- Voice chat (WebRTC), HTTPS config and password recovery. Room state lives in memory (accounts are in the database).
- Google sign-in: set GOOGLE_CLIENT_ID on the server. The page reads it from /config, shows Google's real button,
  and the server verifies the token. Your site's address must be listed as an authorised origin in Google Cloud Console.
- Friends, settings and the Google account list are still local/demo data in the page.

## Socket events (client -> server)
room:create {name,size,cfg} | room:join {code,name,team} | room:rejoin {code,token} | room:spectate {code}
room:ready bool | room:team 0/1 | room:fill | room:start | game:target n | game:click n | game:view {top,peek}
chat text | queue:join {name,size} | queue:leave | auth:google {credential}

## Deploy (Render, free tier)
1. Create a GitHub repository and push this folder to it.
2. On render.com choose New > Blueprint, pick the repository. render.yaml sets everything up.
3. Open the URL Render gives you (https://number-hunt-xxxx.onrender.com). Share it with friends.
4. Optional Google sign-in: in Google Cloud Console add that URL under Authorised JavaScript origins,
   then set GOOGLE_CLIENT_ID in the Render dashboard (Environment) and redeploy.
Notes: the free tier sleeps after ~15 minutes without visitors (the first load then takes ~30 s) and rooms
live in memory, so a restart ends running matches. Fly.io, Railway or any Node/Docker host also works
(the Dockerfile listens on $PORT). Static hosts such as Netlify cannot run this server.
