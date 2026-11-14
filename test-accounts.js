/* Accounts end-to-end test: register/login, tokens, friends, presence, invites, match history, stats, profile, delete. */
process.env.PORT = process.env.PORT || '3992';
process.env.DB_FILE = ':memory:';
process.env.SESSION_SECRET = 'test-secret';
process.env.SPECTATOR_DELAY_MS = '300';
const { io: Client } = require('socket.io-client');
const { ready } = require('./server');
const base = 'http://localhost:' + process.env.PORT;
let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const call = async (method, path, body, tok) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const emitP = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const used = new Set();

function player(name, tok) {
  const s = Client(base), a = { s, name, round: null, over: null, invites: [] };
  s.on('game:round', r => { a.round = r; act(a); });
  s.on('game:state', r => { a.round = { ...a.round, ...r }; act(a); });
  s.on('game:over', o => { a.over = o; });
  s.on('invite', i => a.invites.push(i));
  a.auth = () => emitP(s, 'auth:token', { token: tok });
  return a;
}
function act(a) {
  const r = a.round; if (!r) return;
  if (r.ph === 'select' && r.sl === a.name) { let v; do { v = Math.floor(Math.random() * 500); } while (used.has(v)); used.add(v); setTimeout(() => a.s.emit('game:target', v, () => {}), 100); }
  if (r.ph === 'search' && r.sr === a.name && r.tg !== null && a.last !== r.r) { a.last = r.r; setTimeout(() => a.s.emit('game:click', r.tg), 200); }
}

(async () => {
  await ready;
  let r = await call('POST', '/api/register', { email: 'bad', username: 'alice', password: 'password1' });
  ok(r.status === 400, 'rejects an invalid email');
  r = await call('POST', '/api/register', { email: 'a@x.com', username: 'al', password: 'password1' }); ok(r.status === 400, 'rejects a short username');
  r = await call('POST', '/api/register', { email: 'a@x.com', username: 'alice', password: 'short' }); ok(r.status === 400, 'rejects a short password');
  const ra = await call('POST', '/api/register', { email: 'alice@x.com', username: 'Alice', password: 'password1' });
  ok(ra.status === 200 && ra.body.token && ra.body.profile.username === 'Alice', 'registers Alice');
  ok(!JSON.stringify(ra.body).includes('password1') && !('pwd' in ra.body.profile), 'password is never returned');
  const rb = await call('POST', '/api/register', { email: 'bob@x.com', username: 'Bobby', password: 'password2' }); ok(rb.status === 200, 'registers Bobby');
  r = await call('POST', '/api/register', { email: 'other@x.com', username: 'alice', password: 'password1' }); ok(r.status === 409, 'username is unique, ignoring case');
  r = await call('POST', '/api/register', { email: 'ALICE@x.com', username: 'Another', password: 'password1' }); ok(r.status === 409, 'email is unique, ignoring case');
  r = await call('POST', '/api/login', { login: 'alice@x.com', password: 'nope-nope' }); ok(r.status === 401, 'wrong password rejected');
  r = await call('POST', '/api/login', { login: 'nobody', password: 'password1' }); ok(r.status === 401 && r.body.error === 'Wrong email/username or password.', 'unknown user gets the same message');
  r = await call('POST', '/api/login', { login: 'alice', password: 'password1' }); ok(r.status === 200, 'logs in with username');
  const ta = r.body.token, tb = rb.body.token;
  r = await call('GET', '/api/me'); ok(r.status === 401, 'no token = 401');
  r = await call('GET', '/api/me', null, ta.slice(0, -3) + 'abc'); ok(r.status === 401, 'tampered token = 401');
  r = await call('GET', '/api/me', null, ta); ok(r.status === 200 && r.body.stats.matches === 0, 'profile loads with empty stats');

  // unique Player IDs + public profile
  ok(/^\d{9}$/.test(ra.body.profile.pid) && /^\d{9}$/.test(rb.body.profile.pid) && ra.body.profile.pid !== rb.body.profile.pid, 'every account gets a unique 9-digit Player ID (' + ra.body.profile.pid + ' / ' + rb.body.profile.pid + ')');
  r = await call('GET', '/api/players/' + rb.body.profile.pid); ok(r.status === 200 && r.body.username === 'Bobby' && r.body.relation === null && !('email' in r.body), 'public profile loads for guests without private data');
  r = await call('GET', '/api/players/000000000'); ok(r.status === 404, 'unknown Player ID = 404');
  r = await call('GET', '/api/players/abc'); ok(r.status === 404, 'malformed Player ID = 404');
  r = await call('GET', '/api/players/' + rb.body.profile.pid, null, ta); ok(r.body.relation === 'none' && r.body.level === 1 && r.body.stats.matches === 0, 'relation is none, level 1, zero matches');
  r = await call('GET', '/api/players/' + ra.body.profile.pid, null, ta); ok(r.body.relation === 'self', 'own profile shows relation self');
  r = await call('GET', '/api/users?q=' + rb.body.profile.pid.slice(0, 6), null, ta); ok(r.body.some(u => u.username === 'Bobby' && u.pid === rb.body.profile.pid), 'search finds a player by Player ID');

  // friends
  r = await call('POST', '/api/friends/request', { username: rb.body.profile.pid }, ta); ok(r.status === 200, 'friend request sent using the Player ID');
  r = await call('GET', '/api/players/' + rb.body.profile.pid, null, ta); ok(r.body.relation === 'outgoing', 'profile shows request sent');
  r = await call('GET', '/api/players/' + ra.body.profile.pid, null, tb); ok(r.body.relation === 'incoming', 'other side sees an incoming request');
  r = await call('POST', '/api/friends/request', { username: 'bobby' }, ta); ok(r.status === 409, 'duplicate request rejected');
  r = await call('POST', '/api/friends/request', { username: 'alice' }, ta); ok(r.status === 400, 'cannot add yourself');
  r = await call('GET', '/api/friends', null, tb); ok(r.body.incoming.length === 1 && r.body.incoming[0].username === 'Alice', 'Bobby sees the incoming request');
  const aliceId = r.body.incoming[0].id;
  r = await call('POST', '/api/friends/accept', { id: aliceId }, tb); ok(r.status === 200, 'Bobby accepts');
  r = await call('GET', '/api/friends', null, ta); ok(r.body.friends.length === 1 && r.body.friends[0].status === 'offline' && r.body.friends[0].pid === rb.body.profile.pid, 'Alice sees Bobby as a friend (offline) with his Player ID');
  r = await call('GET', '/api/players/' + rb.body.profile.pid, null, ta); ok(r.body.relation === 'friend', 'profile shows friend');
  r = await call('GET', '/api/users?q=bob', null, ta); ok(r.body.length === 1 && r.body[0].username === 'Bobby', 'player search works');

  // sockets, presence, invite
  const A = player('Alice', ta), B = player('Bobby', tb);
  ok((await A.auth()).ok && (await B.auth()).ok, 'sockets authenticate with tokens');
  ok(!(await emitP(Client(base), 'auth:token', { token: 'garbage' })).ok, 'bad socket token refused');
  r = await call('GET', '/api/friends', null, ta); ok(r.body.friends[0].status === 'online', 'presence: Bobby shows online');
  const room = await emitP(A.s, 'room:create', { name: 'SomeoneElse', size: 2, cfg: { search: 8, target: 8, win: 'score', val: 2 } });
  ok(room.name === 'Alice', 'signed-in players use their account name, not the typed one');
  const inv = await emitP(A.s, 'friend:invite', { id: r.body.friends[0].id }); await wait(200);
  ok(inv.ok && B.invites.length === 1 && B.invites[0].code === room.code && B.invites[0].from === 'Alice', 'friend invite delivered with the room code');
  const stranger = Client(base); ok(!(await emitP(stranger, 'friend:invite', { id: aliceId })).ok, 'guests cannot invite');
  ok((await emitP(B.s, 'room:join', { code: room.code, name: 'x' })).ok, 'Bobby joins from the invite');
  await wait(300);
  r = await call('GET', '/api/friends', null, ta); ok(r.body.friends[0].status === 'online', 'presence: lobby counts as online');
  A.s.emit('room:fill'); A.s.emit('room:start'); await wait(600);
  r = await call('GET', '/api/friends', null, ta); ok(r.body.friends[0].status === 'match', 'presence: Bobby shows "in a match"');
  const t0 = Date.now(); while (!(A.over && B.over) && Date.now() - t0 < 120000) await wait(250);
  ok(!!A.over, 'match finished'); await wait(600);

  // history + stats
  const ma = await call('GET', '/api/matches', null, ta), mb = await call('GET', '/api/matches', null, tb);
  ok(ma.body.length === 1 && mb.body.length === 1, 'match saved to both accounts');
  const x = ma.body[0], y = mb.body[0];
  ok(x.sa + x.sb >= 2 && x.size === 2 && x.win === 'score', 'match row has score and format (' + x.sa + '-' + x.sb + ')');
  ok([x.result, y.result].sort().join('') === 'LW', 'one W and one L recorded (' + x.result + '/' + y.result + ')');
  r = await call('GET', '/api/me', null, ta);
  ok(r.body.stats.matches === 1 && r.body.stats.wins + r.body.stats.losses === 1 && r.body.stats.correct >= 0, 'stats aggregate correctly');
  r = await call('GET', '/api/players/' + ra.body.profile.pid, null, tb); ok(r.body.stats.matches === 1 && r.body.recent.length === 1 && r.body.recent[0].sa + r.body.recent[0].sb >= 2 && r.body.level >= 1, 'public profile shows times played and recent form to other players');
  const winner = x.result === 'W' ? r.body : (await call('GET', '/api/me', null, tb)).body;
  ok(winner.stats.accuracy !== null && winner.stats.avgMs > 0 && winner.stats.correct >= 1, 'winner has accuracy and average find time');

  // profile edits
  r = await call('PUT', '/api/me', { bio: 'Fast hands <b>', avatar: '5' }, ta); ok(r.body.bio === 'Fast hands b' && r.body.avatar === '5', 'bio is sanitised, avatar saved');
  r = await call('PUT', '/api/me', { avatar: '99' }, ta); ok(r.status === 400, 'invalid avatar rejected');
  r = await call('PUT', '/api/me', { username: 'Bobby' }, ta); ok(r.status === 409, 'cannot take another username');
  r = await call('PUT', '/api/me', { username: 'Alice_Pro' }, ta); ok(r.status === 200 && r.body.username === 'Alice_Pro', 'username can be changed');

  // google without config
  r = await call('POST', '/api/google', { credential: 'x' }); ok(r.status === 400, 'Google endpoint refuses when no Client ID is configured');

  // remove friend, delete account
  r = await call('DELETE', '/api/friends/' + aliceId, null, tb); r = await call('GET', '/api/friends', null, ta); ok(r.body.friends.length === 0, 'friend removed on both sides');
  r = await call('DELETE', '/api/me', null, tb); ok(r.status === 200, 'account deleted');
  r = await call('POST', '/api/login', { login: 'bobby', password: 'password2' }); ok(r.status === 401, 'deleted account cannot log in');
  r = await call('GET', '/api/me', null, tb); ok(r.status === 401 || r.status === 404, 'old token no longer works');
  console.log(failed ? '\n' + failed + ' FAILED' : '\nALL ACCOUNT TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
