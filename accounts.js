'use strict';
/* Accounts: register/login (scrypt password hashes), Google sign-in, profiles, stats, match history, friends. */
const crypto = require('crypto');
const open = require('./store');
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set: everyone is signed out whenever the server restarts.');
const uid = () => crypto.randomBytes(8).toString('hex');
const bad = (status, msg) => Object.assign(new Error(msg), { status });
const N = v => Number(v) || 0;

function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function checkPw(pw, stored) {
  const [salt, h] = String(stored || '').split(':'); if (!salt || !h) return false;
  const x = crypto.scryptSync(pw, salt, 64), y = Buffer.from(h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const sig = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const token = id => { const b = id + '.' + (Date.now() + 30 * 864e5); return b + '.' + sig(b); };
function verify(t) {
  const p = String(t || '').split('.'); if (p.length !== 3) return null;
  const a = Buffer.from(p[2]), b = Buffer.from(sig(p[0] + '.' + p[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(p[1]) > Date.now() ? p[0] : null;
}

module.exports = async function init() {
  const db = await open();
  const one = async (s, p) => (await db.all(s, p))[0] || null;
  const pubUser = u => u && { id: u.id, pid: u.pid, username: u.username, avatar: u.avatar || '0', bio: u.bio || '', created: N(u.created), email: u.email || null };
  /* every account gets a unique 9-digit Player ID (shown on the profile, used to find and add friends) */
  async function newPid() {
    for (;;) { const c = String(100000000 + crypto.randomInt(900000000)); if (!(await one('SELECT id FROM users WHERE pid = ?', [c]))) return c; }
  }
  for (const r of await db.all('SELECT id FROM users WHERE pid IS NULL')) await db.run('UPDATE users SET pid = ? WHERE id = ?', [await newPid(), r.id]);   // backfill older accounts
  const levelOf = st => { const xp = st.matches * 10 + st.wins * 15 + st.draws * 5; return { level: 1 + Math.floor(xp / 50), xp, xpInto: xp % 50, xpNext: 50 }; };
  const A = {
    kind: db.kind, verify, token,
    async user(id) { return pubUser(await one('SELECT * FROM users WHERE id = ?', [id])); },
    async session(u) { return { token: token(u.id), profile: u }; },
    async register({ email, username, password } = {}) {
      email = String(email || '').trim().toLowerCase(); username = String(username || '').trim(); password = String(password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad(400, 'Enter a valid email address.');
      if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw bad(400, 'Username must be 3-16 letters, numbers or underscores.');
      if (password.length < 8 || password.length > 72) throw bad(400, 'Password must be 8 to 72 characters.');
      if (await one('SELECT id FROM users WHERE email = ?', [email])) throw bad(409, 'That email is already registered.');
      if (await one('SELECT id FROM users WHERE lower(username) = ?', [username.toLowerCase()])) throw bad(409, 'That username is taken.');
      const id = uid();
      await db.run('INSERT INTO users(id,email,username,pwd,name,avatar,bio,created,pid) VALUES(?,?,?,?,?,?,?,?,?)', [id, email, username, hashPw(password), username, '0', '', Date.now(), await newPid()]);
      return A.user(id);
    },
    async login({ login, password } = {}) {
      const l = String(login || '').trim().toLowerCase();
      const u = await one('SELECT * FROM users WHERE email = ? OR lower(username) = ?', [l, l]);
      if (!u || !checkPw(String(password || ''), u.pwd)) throw bad(401, 'Wrong email/username or password.');   // same message for both cases
      return pubUser(u);
    },
    async googleLogin(g) {
      if (!g || !g.sub) throw bad(401, 'Invalid Google token');
      const verified = g.email_verified === true || g.email_verified === 'true';       // only trust an email Google has verified
      if (!verified) g = { ...g, email: null };
      let u = await one('SELECT * FROM users WHERE gsub = ?', [g.sub]);
      if (!u && g.email) { u = await one('SELECT * FROM users WHERE email = ?', [String(g.email).toLowerCase()]); if (u) await db.run('UPDATE users SET gsub = ? WHERE id = ?', [g.sub, u.id]); }
      if (!u) {
        let base = String(g.name || g.email || 'Player').split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 12) || 'Player', name = base, n = 1;
        while (await one('SELECT id FROM users WHERE lower(username) = ?', [name.toLowerCase()])) name = base + (++n);
        const id = uid();
        await db.run('INSERT INTO users(id,email,username,gsub,name,avatar,bio,created,pid) VALUES(?,?,?,?,?,?,?,?,?)', [id, String(g.email || '').toLowerCase() || null, name, g.sub, g.name || name, '0', '', Date.now(), await newPid()]);
        u = await one('SELECT * FROM users WHERE id = ?', [id]);
      }
      return pubUser(u);
    },
    async profile(id) {
      const u = await A.user(id); if (!u) throw bad(404, 'Account not found');
      const s = await one(`SELECT COUNT(*) g, SUM(CASE WHEN result='W' THEN 1 ELSE 0 END) w, SUM(CASE WHEN result='D' THEN 1 ELSE 0 END) d,
        SUM(correct) c, SUM(wrong) x, AVG(avgms) a FROM match_players WHERE user_id = ?`, [id]);
      const c = N(s.c), x = N(s.x);
      u.stats = { matches: N(s.g), wins: N(s.w), draws: N(s.d), losses: N(s.g) - N(s.w) - N(s.d), correct: c, wrong: x, accuracy: c + x ? c / (c + x) : null, avgMs: s.a === null || s.a === undefined ? null : N(s.a) };
      Object.assign(u, levelOf(u.stats));
      return u;
    },
    /* public profile of any player, looked up by Player ID. `relation` tells the viewer how they are connected. */
    async publicProfile(pid, viewerId) {
      const row = await one('SELECT id FROM users WHERE pid = ?', [String(pid)]); if (!row) throw bad(404, 'Player not found');
      const p = await A.profile(row.id), recent = (await A.matches(row.id)).slice(0, 5);
      let relation = null;
      if (viewerId) {
        if (viewerId === row.id) relation = 'self';
        else {
          const f = await one('SELECT a, status FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', [viewerId, row.id, row.id, viewerId]);
          relation = !f ? 'none' : f.status === 'accepted' ? 'friend' : f.a === viewerId ? 'outgoing' : 'incoming';
        }
      }
      return { id: p.id, pid: p.pid, username: p.username, avatar: p.avatar, bio: p.bio, created: p.created, stats: p.stats,
               level: p.level, xp: p.xp, xpInto: p.xpInto, xpNext: p.xpNext, relation,
               recent: recent.map(m => ({ result: m.result, sa: m.sa, sb: m.sb, team: m.team, ended: m.ended })) };    // no email, no private data
    },
    async update(id, p = {}) {
      const set = [], v = [];
      if (p.username !== undefined) {
        const un = String(p.username).trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(un)) throw bad(400, 'Username must be 3-16 letters, numbers or underscores.');
        if (await one('SELECT id FROM users WHERE lower(username) = ? AND id <> ?', [un.toLowerCase(), id])) throw bad(409, 'That username is taken.');
        set.push('username = ?'); v.push(un);
      }
      if (p.bio !== undefined) { set.push('bio = ?'); v.push(String(p.bio).replace(/[<>]/g, '').slice(0, 80)); }
      if (p.avatar !== undefined) { if (!/^[0-7]$/.test(String(p.avatar))) throw bad(400, 'Invalid avatar'); set.push('avatar = ?'); v.push(String(p.avatar)); }
      if (set.length) await db.run(`UPDATE users SET ${set.join(', ')} WHERE id = ?`, [...v, id]);
      return A.profile(id);
    },
    async removeAccount(id) {
      await db.run('DELETE FROM friends WHERE a = ? OR b = ?', [id, id]);
      await db.run('UPDATE match_players SET user_id = NULL WHERE user_id = ?', [id]);
      await db.run('DELETE FROM users WHERE id = ?', [id]); return { ok: true };
    },
    async record(m) {
      const id = uid();
      await db.run('INSERT INTO matches(id,ended,size,win,val,sa,sb,duration,result) VALUES(?,?,?,?,?,?,?,?,?)', [id, Date.now(), m.size, m.win, m.val, m.sa, m.sb, m.duration, m.result]);
      for (const p of m.players)
        await db.run('INSERT INTO match_players(match_id,user_id,name,team,result,correct,wrong,avgms,mvp) VALUES(?,?,?,?,?,?,?,?,?)', [id, p.userId || null, p.name, p.team, p.res, p.c, p.w, p.avg, p.mvp ? 1 : 0]);
    },
    async matches(id) {
      const rows = await db.all(`SELECT m.ended, m.size, m.win, m.val, m.sa, m.sb, m.duration, mp.team, mp.result, mp.correct, mp.wrong, mp.mvp
        FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE mp.user_id = ? ORDER BY m.ended DESC LIMIT 20`, [id]);
      return rows.map(r => ({ ended: N(r.ended), size: N(r.size), win: r.win, val: N(r.val), sa: N(r.sa), sb: N(r.sb), duration: N(r.duration), team: r.team, result: r.result, correct: N(r.correct), wrong: N(r.wrong), mvp: !!N(r.mvp) }));
    },
    async friends(id) {
      const rows = await db.all(`SELECT f.a, f.status, u.id uid, u.pid, u.username, u.avatar FROM friends f
        JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE f.a = ? OR f.b = ?`, [id, id, id]);
      const out = { friends: [], incoming: [], outgoing: [] };
      for (const r of rows) {
        const u = { id: r.uid, pid: r.pid, username: r.username, avatar: r.avatar || '0' };
        (r.status === 'accepted' ? out.friends : r.a === id ? out.outgoing : out.incoming).push(u);
      }
      return out;
    },
    async areFriends(a, b) { return !!(await one(`SELECT 1 x FROM friends WHERE status = 'accepted' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))`, [a, b, b, a])); },
    async request(id, who) {                                                      // `who` is a Player ID (9 digits) or a username
      who = String(who || '').trim().replace(/^#/, '');
      let t = /^\d{9}$/.test(who) ? await one('SELECT id FROM users WHERE pid = ?', [who]) : null;
      if (!t) t = await one('SELECT id FROM users WHERE lower(username) = ?', [who.toLowerCase()]);
      if (!t) throw bad(404, 'No player with that ID or username.'); if (t.id === id) throw bad(400, 'You cannot add yourself.');
      const ex = await one('SELECT a, status FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', [id, t.id, t.id, id]);
      if (ex) {
        if (ex.status === 'accepted') throw bad(409, 'You are already friends.');
        if (ex.a === t.id) return A.accept(id, t.id);                                   // they asked first: accept
        throw bad(409, 'Request already sent.');
      }
      await db.run(`INSERT INTO friends(a,b,status,created) VALUES(?,?,'pending',?)`, [id, t.id, Date.now()]); return { ok: true };
    },
    async accept(id, other) { await db.run(`UPDATE friends SET status = 'accepted' WHERE a = ? AND b = ? AND status = 'pending'`, [other, id]); return { ok: true }; },
    async removeFriend(id, other) { await db.run('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', [id, other, other, id]); return { ok: true }; },
    async search(q, id) {
      q = String(q || '').trim().toLowerCase().replace(/^#/, '').replace(/[%_]/g, '');
      const rows = q
        ? await db.all(`SELECT id, pid, username, avatar FROM users WHERE id <> ? AND (lower(username) LIKE ? OR pid LIKE ?) ORDER BY username LIMIT 10`, [id, '%' + q + '%', q + '%'])
        : await db.all('SELECT id, pid, username, avatar FROM users WHERE id <> ? ORDER BY created DESC LIMIT 10', [id]);
      return rows.map(r => ({ id: r.id, pid: r.pid, username: r.username, avatar: r.avatar || '0' }));
    },
  };
  return A;
};
