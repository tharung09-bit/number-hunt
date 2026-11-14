'use strict';
/* Number Hunt - server-authoritative multiplayer.
   The server owns: rooms, teams, rotations, timers, targets, clicks, scores, bots, spectator delay.
   Clients only send intentions (pick a target, click a tile, scroll position) and render what the server says. */
try { process.loadEnvFile(); } catch (e) { /* no .env file: use real environment variables */ }   // Node 22+
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DELAY = Number(process.env.SPECTATOR_DELAY_MS || 3000);   // anti-cheat delay for spectators
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const BOARDS = [150, 250, 350, 450, 500, 750, 1000];   // board sizes a room can choose (numbers 0 .. size-1)
const pickBoard = v => BOARDS.includes(Number(v)) ? Number(v) : 500;
const rooms = new Map();
const queues = {};                                  // quick-match queues keyed by 'teamSize:boardSize'

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, accounts: !!A }));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ---------- helpers ---------- */
const rnd = (a, b) => a + Math.random() * (b - a);
const clean = (s, n = 18) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n) || 'Player';
/* team names: anything the players choose, but plain text only (no markup / control characters), max 16 chars */
const cleanTeam = (s, d) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16) || d;
const cleanTN = tn => { const a = cleanTeam(tn && tn[0], 'Team A'); let b = cleanTeam(tn && tn[1], 'Team B');
  if (a.toLowerCase() === b.toLowerCase()) b = (b.slice(0, 14) + ' 2'); return [a, b]; };
const clamp = (v, a, b, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(b, Math.max(a, v)) : d; };
const BOTS = ['Kuro', 'Raiden', 'Mochi', 'Vex', 'Lyra', 'Orion', 'Echo', 'Blitz', 'Sora', 'Ryu', 'Nova', 'Zed'];
const uid = () => Math.random().toString(36).slice(2, 10);

function newCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s;
  do { s = 'NH-'; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; } while (rooms.has(s));
  return s;
}
function mkPlayer(name, bot, sock) {
  return { id: uid(), token: uid() + uid(), name: clean(name), bot: !!bot, ready: !!bot, sock: sock || null,
           returning: false, team: 0, st: { c: 0, w: 0, t: [] } };
}
function cleanCfg(c) {
  c = c || {};
  const win = ['score', 'rounds', 'time'].includes(c.win) ? c.win : 'score';
  const val = win === 'score' ? clamp(c.val, 1, 50, 10) : win === 'rounds' ? clamp(c.val, 5, 60, 20) : clamp(c.val, 3, 60, 10);
  return { search: clamp(c.search, 15, 120, 45), target: clamp(c.target, 10, 60, 20), win, val, board: pickBoard(c.board) };
}
function mkRoom(size, cfg) {
  const room = { code: newCode(), size, cfg, tn: ['Team A', 'Team B'], host: null, state: 'lobby', spec: new Set(),
                 T: [Array(size).fill(null), Array(size).fill(null)], game: null, last: Date.now() };
  rooms.set(room.code, room); return room;
}
const all = r => r.T[0].concat(r.T[1]).filter(Boolean);
const humans = r => all(r).filter(p => !p.bot || p.sockWas);
function addPlayer(room, p, pref) {
  const free = k => room.T[k].indexOf(null);
  let t = (pref === 0 || pref === 1) ? pref : null;
  if (t === null || free(t) < 0) t = room.T[0].filter(Boolean).length <= room.T[1].filter(Boolean).length ? 0 : 1;
  if (free(t) < 0) t = 1 - t;
  const i = free(t); if (i < 0) return false;
  room.T[t][i] = p; p.team = t;
  const base = p.name; let n = 1;                                   // names must be unique inside a room
  while (all(room).some(x => x !== p && x.name === p.name)) { n++; p.name = base.slice(0, 15) + ' ' + n; }
  return true;
}
function pub(room) {
  return { code: room.code, size: room.size, cfg: room.cfg, tn: room.tn, state: room.state, host: room.host && room.host.id,
    teams: room.T.map(a => a.map(p => p ? { id: p.id, pid: p.pid || null, name: p.name, bot: p.bot, ready: p.ready, online: !!p.sock || p.bot } : null)) };
}
/* players get events immediately, spectators get them after the anti-cheat delay */
function emit(room, ev, data, skip) {
  for (const p of all(room)) if (p.sock && p.sock !== skip) p.sock.emit(ev, data);
  for (const s of room.spec) setTimeout(() => s.emit(ev, data), DELAY);
}
const lobby = room => emit(room, 'room:state', pub(room));
function bind(sock, room, p) { sock.data = { room, p }; room.last = Date.now(); }
function fillBots(room) {
  for (let t = 0; t < 2; t++) for (let i = 0; i < room.size; i++) if (!room.T[t][i]) {
    const used = new Set(all(room).map(p => p.name));
    const b = mkPlayer(BOTS.find(n => !used.has(n)) || 'Bot' + t + i, true); b.team = t; room.T[t][i] = b;
  }
}

/* ---------- game engine ---------- */
function stop(g) { clearTimeout(g.timer); clearInterval(g.view); }
function snap(room) {
  const g = room.game, u = g.cur;
  return { r: g.r, sc: g.sc, ph: u.ph, ts: u.ts, sr: u.sr.name, sl: u.sl.name, tg: u.ph === 'select' ? null : u.tg,
           dl: u.dl, now: Date.now(), cfg: room.cfg };
}
const feed = (room, text) => emit(room, 'game:event', { text });

function startGame(room) {
  if (room.state !== 'lobby') return;
  fillBots(room);
  all(room).forEach(p => { p.st = { c: 0, w: 0, t: [] }; });
  room.state = 'play';
  room.game = { r: 0, sc: [0, 0], si: [0, 0], ti: [0, 0], used: new Set(), t0: Date.now(), cur: null, timer: null, view: null, over: false };
  lobby(room); nextRound(room);
}
function nextRound(room) {
  const g = room.game, c = room.cfg; if (!g || g.over) return;
  stop(g);
  if (g.used.size >= c.board - 1) g.used.clear();                         // long matches on small boards: allow targets again
  const el = Date.now() - g.t0;
  if ((c.win === 'score' && Math.max(...g.sc) >= c.val) || (c.win === 'rounds' && g.r >= c.val) || (c.win === 'time' && el >= c.val * 60000))
    return endGame(room);
  all(room).forEach(p => { if (p.returning && p.sock) { p.bot = false; p.returning = false; } });   // hand control back
  /* two independent rotations per team: who searches, who selects */
  const ts = g.r % 2, ss = 1 - ts, n = room.size;
  const sr = room.T[ts][g.si[ts] % n], sl = room.T[ss][g.ti[ss] % n];
  g.si[ts]++; g.ti[ss]++; g.r++;
  const order = [...Array(room.cfg.board).keys()];
  for (let i = room.cfg.board - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  g.cur = { ts, sr, sl, tg: null, ph: 'select', dl: Date.now() + c.target * 1000, t0: Date.now(), order };
  emit(room, 'game:round', { ...snap(room), order });
  const rr = g.r;
  g.timer = setTimeout(() => expire(room, rr), c.target * 1000 + 50);
  if (sl.bot) setTimeout(() => {
    if (g.r !== rr || g.over || g.cur.ph !== 'select') return;
    let v; do { v = Math.floor(Math.random() * room.cfg.board); } while (g.used.has(v));
    setTarget(room, sl, v);
  }, rnd(900, Math.max(1500, c.target * 600)));
}
function setTarget(room, p, v) {
  const g = room.game, u = g && g.cur;
  if (!u || g.over || u.ph !== 'select') return 'Not choosing a target right now';
  if (p !== u.sl) return 'Only the selector can choose the target';
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= room.cfg.board) return `Enter a whole number from 0 to ${room.cfg.board - 1}`;
  if (g.used.has(v)) return v + ' was already used. Choose another target';
  g.used.add(v); u.tg = v; u.ph = 'search'; u.t0 = Date.now(); u.dl = u.t0 + room.cfg.search * 1000;
  clearTimeout(g.timer); const rr = g.r;
  g.timer = setTimeout(() => expire(room, rr), room.cfg.search * 1000 + 50);
  emit(room, 'game:state', snap(room)); feed(room, `Round ${g.r}: ${p.name} chose the target.`);
  if (u.sr.bot) botSearch(room, rr);
  return null;
}
function botSearch(room, rr) {                       /* medium difficulty: finds it ~72% of the time */
  const g = room.game, u = g.cur, ok = Math.random() < .72, ms = ok ? rnd(2500, room.cfg.search * 850) : 0;
  const f = u.order.indexOf(u.tg) / room.cfg.board, t0 = Date.now();
  g.view = setInterval(() => {                       /* bots "scroll" too, so everyone sees a live view */
    const el = Date.now() - t0, q = ok ? Math.min(1, el / ms) : 0;
    const top = ok ? f * Math.pow(q, 1.1) + .2 * Math.sin(el / 420) * (1 - q) : .5 + .46 * Math.sin(el / 1700);
    emit(room, 'game:view', { who: u.sr.name, top: Math.max(0, Math.min(1, top)), peek: null });
  }, 150);
  if (ok) setTimeout(() => { if (g.r === rr && g.cur.ph === 'search') { u.sr.st.w += Math.floor(ms / 2500); found(room, u.sr, ms); } }, ms);
  else u.sr.st.w += Math.floor(rnd(2, 8));
}
function click(room, p, n) {
  const g = room.game, u = g && g.cur;
  if (!u || g.over || u.ph !== 'search' || p !== u.sr) return;     // only the active searcher may click
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= room.cfg.board) return;
  if (n === u.tg) found(room, p, Date.now() - u.t0);
  else { p.st.w++; if (p.sock) p.sock.emit('game:wrong', n); }     // wrong clicks: no penalty
}
function found(room, p, ms) {
  const g = room.game, u = g.cur; stop(g);
  u.ph = 'between'; g.sc[u.ts]++; p.st.c++; p.st.t.push(ms);
  emit(room, 'game:state', { ...snap(room), found: { name: p.name, ms } });
  feed(room, `${p.name} found ${u.tg} in ${(ms / 1000).toFixed(1)} s. ${room.tn[u.ts]} +1`);
  g.timer = setTimeout(() => nextRound(room), 1500);
}
function expire(room, rr) {
  const g = room.game; if (!g || g.over || g.r !== rr || g.cur.ph === 'between') return;
  const u = g.cur; stop(g);
  feed(room, u.ph === 'select' ? `${room.tn[1 - u.ts]} ran out of time. Round skipped, no point.` : `Time up. Nobody found ${u.tg}.`);
  u.ph = 'between'; emit(room, 'game:state', snap(room));
  g.timer = setTimeout(() => nextRound(room), 1500);
}
function endGame(room) {
  const g = room.game; stop(g); g.over = true; room.state = 'done';
  const rows = all(room).map(p => ({ name: p.name, pid: p.pid || null, team: 'AB'[p.team], c: p.st.c, w: p.st.w,
    avg: p.st.t.length ? p.st.t.reduce((a, b) => a + b, 0) / p.st.t.length : null }));
  let best = null;
  rows.forEach(r => { const acc = r.c + r.w ? r.c / (r.c + r.w) : 0; if (!best || r.c > best.c || (r.c === best.c && acc > best.acc)) best = { name: r.name, c: r.c, acc }; });
  if (A && all(room).some(p => p.userId)) {
    const res = g.sc[0] === g.sc[1] ? 'draw' : g.sc[0] > g.sc[1] ? 'A' : 'B';
    A.record({ size: room.size, win: room.cfg.win, val: room.cfg.val, sa: g.sc[0], sb: g.sc[1], duration: Date.now() - g.t0, result: res,
      players: all(room).map(p => { const r = rows.find(x => x.name === p.name);
        return { userId: p.userId, name: p.name, team: 'AB'[p.team], res: res === 'draw' ? 'D' : (res === 'AB'[p.team] ? 'W' : 'L'),
                 c: p.st.c, w: p.st.w, avg: r ? r.avg : null, mvp: !!best && best.name === p.name }; }) })
      .catch(e => console.error('Saving match failed:', e.message));
  }
  emit(room, 'game:over', { score: g.sc, tn: room.tn, rows, mvp: best && best.name, duration: Date.now() - g.t0,
                            result: g.sc[0] === g.sc[1] ? 'draw' : g.sc[0] > g.sc[1] ? 'A' : 'B' });   // equal score = draw, no overtime
  lobby(room);
}

/* ---------- accounts, REST API, presence ---------- */
let A = null;                                       // set when the database is ready
const presenceMap = new Map();                      // userId -> Set(sockets)
const statusOf = id => {
  const set = presenceMap.get(id); if (!set || !set.size) return 'offline';
  for (const k of set) if (k.data && k.data.room && k.data.room.state === 'play' && !k.data.spectator) return 'match';
  return 'online';
};
async function attach(sock, tok) {                  // bind a signed-in account to a socket
  if (sock.user) { const s = presenceMap.get(sock.user.id); if (s) { s.delete(sock); if (!s.size) presenceMap.delete(sock.user.id); } sock.user = null; }
  const id = A && A.verify(tok); if (!id) return null;
  const u = await A.user(id); if (!u) return null;
  sock.user = u; if (!presenceMap.has(u.id)) presenceMap.set(u.id, new Set()); presenceMap.get(u.id).add(sock); return u;
}
async function verifyGoogle(credential) {
  if (!GOOGLE_CLIENT_ID) throw Object.assign(new Error('Google sign-in is not set up on this server'), { status: 400 });
  try {
    const { OAuth2Client } = require('google-auth-library');
    const t = await new OAuth2Client(GOOGLE_CLIENT_ID).verifyIdToken({ idToken: String(credential || ''), audience: GOOGLE_CLIENT_ID });
    return t.getPayload();
  } catch (e) { throw Object.assign(new Error('Invalid Google token'), { status: 401 }); }
}
const limiter = (max, ms) => { const h = new Map(); return (req, res, next) => {
  const k = req.ip, n = Date.now(), a = (h.get(k) || []).filter(t => n - t < ms);
  if (a.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  a.push(n); h.set(k, a); next(); }; };
const api = f => async (req, res) => {
  try { if (!A) return res.status(503).json({ error: 'Accounts are not available on this server' }); res.json(await f(req)); }
  catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); }
};
const authed = f => api(async req => {
  const id = A.verify((req.get('authorization') || '').replace(/^Bearer /, ''));
  if (!id) throw Object.assign(new Error('Please sign in'), { status: 401 });
  return f(req, id);
});
const withStatus = d => { const add = u => ({ ...u, status: statusOf(u.id) }); return { friends: d.friends.map(add), incoming: d.incoming, outgoing: d.outgoing }; };
app.post('/api/register', limiter(10, 60000), api(async req => A.session(await A.register(req.body))));
app.post('/api/login', limiter(10, 60000), api(async req => A.session(await A.login(req.body))));
app.post('/api/google', limiter(20, 60000), api(async req => { const g = await verifyGoogle(req.body && req.body.credential); return A.session(await A.googleLogin(g)); }));
app.get('/api/me', authed((req, id) => A.profile(id)));
app.put('/api/me', authed((req, id) => A.update(id, req.body)));
app.delete('/api/me', authed((req, id) => A.removeAccount(id)));
app.get('/api/matches', authed((req, id) => A.matches(id)));
app.get('/api/players/:pid', api(async req => {                      // public profile page data (anyone can look; sign in to see your relationship)
  const viewer = A.verify((req.get('authorization') || '').replace(/^Bearer /, ''));
  if (!/^\d{9}$/.test(req.params.pid)) throw Object.assign(new Error('Player not found'), { status: 404 });
  const d = await A.publicProfile(req.params.pid, viewer); d.status = statusOf(d.id); return d;
}));
app.get('/api/users', authed((req, id) => A.search(req.query.q, id)));
app.get('/api/friends', authed(async (req, id) => withStatus(await A.friends(id))));
app.post('/api/friends/request', authed((req, id) => A.request(id, req.body && req.body.username)));
app.post('/api/friends/accept', authed((req, id) => A.accept(id, String(req.body && req.body.id))));
app.delete('/api/friends/:id', authed((req, id) => A.removeFriend(id, req.params.id)));

/* ---------- sockets ---------- */
io.on('connection', sock => {
  const ctx = () => sock.data || {};
  const done = (cb, o) => typeof cb === 'function' && cb(o);

  sock.on('room:create', ({ name, size, cfg, tn } = {}, cb) => {
    const room = mkRoom(clamp(size, 1, 6, 3), cleanCfg(cfg)); room.tn = cleanTN(tn); const p = mkPlayer(sock.user ? sock.user.username : name, false, sock); p.userId = sock.user && sock.user.id; p.pid = sock.user && sock.user.pid;
    room.host = p; addPlayer(room, p, 0); bind(sock, room, p);
    done(cb, { ok: true, code: room.code, token: p.token, id: p.id, name: p.name }); lobby(room);
  });
  sock.on('room:join', ({ code, name, team } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return done(cb, { ok: false, error: 'Room not found' });
    if (room.state !== 'lobby') return done(cb, { ok: false, error: 'Match already started. You can spectate it.' });
    const p = mkPlayer(sock.user ? sock.user.username : name, false, sock); p.userId = sock.user && sock.user.id; p.pid = sock.user && sock.user.pid;
    if (!addPlayer(room, p, team)) return done(cb, { ok: false, error: 'Room is full' });
    bind(sock, room, p); done(cb, { ok: true, code: room.code, token: p.token, id: p.id, name: p.name }); lobby(room);
  });
  sock.on('room:rejoin', ({ code, token } = {}, cb) => {                 // reconnect: a bot kept your seat warm
    const room = rooms.get(String(code || '').toUpperCase());
    const p = room && all(room).find(x => x.token === token);
    if (!p) return done(cb, { ok: false, error: 'Session expired' });
    p.sock = sock; p.sockWas = true; bind(sock, room, p);
    if (room.state === 'play') p.returning = true;                       // control returns at the next round
    done(cb, { ok: true, code: room.code, id: p.id, name: p.name }); sock.emit('room:state', pub(room));
    if (room.game && room.game.cur && !room.game.over) sock.emit('game:round', { ...snap(room), order: room.game.cur.order });
  });
  sock.on('room:spectate', ({ code } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return done(cb, { ok: false, error: 'Room not found' });
    room.spec.add(sock); sock.data = { room, spectator: true };
    done(cb, { ok: true, code: room.code, delayMs: DELAY }); sock.emit('room:state', pub(room));
    if (room.game && room.game.cur && !room.game.over) sock.emit('game:round', { ...snap(room), order: room.game.cur.order });
  });
  sock.on('room:ready', v => { const { room, p } = ctx(); if (!room || !p || room.state !== 'lobby') return; p.ready = !!v; lobby(room); });
  sock.on('room:team', t => {
    const { room, p } = ctx(); if (!room || !p || room.state !== 'lobby') return;
    t = t === 1 ? 1 : 0; const i = room.T[t].indexOf(null); if (i < 0 || p.team === t) return;
    room.T[p.team][room.T[p.team].indexOf(p)] = null; room.T[t][i] = p; p.team = t; lobby(room);
  });
  sock.on('room:teamname', ({ t, name } = {}, cb) => {                    // any member of a team (or the host) can rename it, only while waiting in the lobby
    const { room, p } = ctx(); if (!room || !p || room.state !== 'lobby') return done(cb, { ok: false });
    t = t === 1 ? 1 : 0; if (p.team !== t && p !== room.host) return done(cb, { ok: false, error: 'Only your own team can be renamed' });
    let nm = cleanTeam(name, 'Team ' + 'AB'[t]); if (nm.toLowerCase() === room.tn[1 - t].toLowerCase()) nm = nm.slice(0, 14) + ' 2';   // two teams never share a name
    const tn = room.tn.slice(); tn[t] = nm; room.tn = tn;
    done(cb, { ok: true, tn: room.tn }); lobby(room);
  });
  sock.on('room:fill', () => { const { room, p } = ctx(); if (room && p === room.host && room.state === 'lobby') { fillBots(room); lobby(room); } });
  sock.on('room:start', () => { const { room, p } = ctx(); if (room && p === room.host) startGame(room); });
  sock.on('game:target', (v, cb) => { const { room, p } = ctx(); if (!room || !p) return; done(cb, { error: setTarget(room, p, v) }); });
  sock.on('game:click', n => { const { room, p } = ctx(); if (room && p) click(room, p, n); });
  sock.on('game:view', ({ top, peek } = {}) => {                         // the searcher's scroll is relayed to everyone
    const { room, p } = ctx(), u = room && room.game && room.game.cur;
    if (!u || u.ph !== 'search' || p !== u.sr) return;
    emit(room, 'game:view', { who: p.name, top: Math.max(0, Math.min(1, Number(top) || 0)),
                              peek: Number.isInteger(peek) && peek >= 0 && peek < room.cfg.board ? peek : null }, sock);
  });
  sock.on('chat', d => {
    const { room, p } = ctx(); if (!room || !p) return;                  // spectators can read but never write
    d = typeof d === 'string' ? { text: d } : (d || {});
    const text = String(d.text || '').replace(/[<>]/g, '').trim().slice(0, 200); if (!text) return;
    const now = Date.now(); p.chatT = (p.chatT || []).filter(t => now - t < 5000);
    if (p.chatT.length >= 5) return;                                      // at most 5 messages per 5 seconds
    p.chatT.push(now);
    const msg = { name: p.name, pid: p.pid || null, team: 'AB'[p.team], text, scope: d.scope === 'team' ? 'team' : 'all' };
    if (msg.scope === 'team') { for (const x of all(room)) if (x.team === p.team && x.sock) x.sock.emit('chat', msg); return; }  // opponents and spectators never see team chat
    emit(room, 'chat', msg);
  });
  sock.on('queue:join', ({ name, size, board } = {}) => {
    size = clamp(size, 1, 6, 3); board = pickBoard(board);
    Object.values(queues).forEach(q => { const i = q.findIndex(e => e.sock === sock); if (i >= 0) q.splice(i, 1); });
    (queues[size + ':' + board] = queues[size + ':' + board] || []).push({ sock, name: sock.user ? sock.user.username : clean(name), userId: sock.user && sock.user.id, pid: sock.user && sock.user.pid, t: Date.now() });
  });
  sock.on('queue:leave', () => Object.values(queues).forEach(q => { const i = q.findIndex(e => e.sock === sock); if (i >= 0) q.splice(i, 1); }));
  sock.on('auth:token', async ({ token } = {}, cb) => { const u = await attach(sock, token); done(cb, u ? { ok: true, profile: u } : { ok: false }); });
  sock.on('friend:invite', async ({ id } = {}, cb) => {
    const { room } = ctx(), me = sock.user;
    if (!me || !A) return done(cb, { ok: false, error: 'Sign in to invite friends' });
    if (!room || room.state !== 'lobby') return done(cb, { ok: false, error: 'Create or join a room first' });
    if (!(await A.areFriends(me.id, String(id)))) return done(cb, { ok: false, error: 'Not on your friends list' });
    const t = presenceMap.get(String(id)); if (!t || !t.size) return done(cb, { ok: false, error: 'That friend is offline' });
    for (const k of t) k.emit('invite', { from: me.username, code: room.code });
    done(cb, { ok: true });
  });
  sock.on('auth:google', async ({ credential } = {}, cb) => {
    try { const x = await verifyGoogle(credential); done(cb, { ok: true, sub: x.sub, name: x.name, email: x.email, picture: x.picture }); }
    catch (e) { done(cb, { ok: false, error: e.message }); }
  });
  sock.on('disconnect', () => {
    if (sock.user) { const set = presenceMap.get(sock.user.id); if (set) { set.delete(sock); if (!set.size) presenceMap.delete(sock.user.id); } }
    Object.values(queues).forEach(q => { const i = q.findIndex(e => e.sock === sock); if (i >= 0) q.splice(i, 1); });
    const { room, p } = ctx(); if (!room) return;
    room.spec.delete(sock); if (!p || p.sock !== sock) return;
    p.sock = null; room.last = Date.now();
    if (room.state === 'lobby') {                                         // leave the lobby
      room.T[p.team][room.T[p.team].indexOf(p)] = null;
      if (room.host === p) room.host = all(room).find(x => !x.bot) || null;
      if (!room.host) return void rooms.delete(room.code);
      lobby(room);
    } else if (room.state === 'play') { p.bot = true; p.sockWas = true; }  // a medium bot takes the seat
  });
});

/* quick match: 8 seconds of waiting fills the rest with bots */
setInterval(() => {
  for (const [key, q] of Object.entries(queues)) {
    if (!q.length) continue;
    const [size, board] = key.split(':').map(Number), need = size * 2; if (q.length < need && Date.now() - q[0].t < 8000) continue;
    const group = q.splice(0, need), room = mkRoom(size, { search: 45, target: 20, win: 'score', val: 5, board });
    group.forEach((e, i) => {
      const p = mkPlayer(e.name, false, e.sock); p.userId = e.userId; p.pid = e.pid; addPlayer(room, p, i % 2); if (!room.host) room.host = p; bind(e.sock, room, p);
      e.sock.emit('queue:matched', { code: room.code, token: p.token, id: p.id, name: p.name });
    });
    lobby(room); setTimeout(() => startGame(room), 3000);
  }
  for (const [code, room] of rooms)                                       // clean up empty rooms
    if (!all(room).some(p => p.sock) && !room.spec.size && Date.now() - room.last > 60000) { if (room.game) stop(room.game); rooms.delete(code); }
}, 1000);

const ready = (async () => {
  try { A = await require('./accounts')(); console.log('Accounts ready (' + A.kind + ')'); }
  catch (e) { console.warn('Accounts disabled:', e.message); }
  await new Promise(r => server.listen(PORT, () => { console.log(`Number Hunt server on http://localhost:${PORT}  (spectator delay ${DELAY} ms)`); r(); }));
})();
module.exports = { server, io, rooms, ready };
