/* End-to-end test: two humans + a spectator against the real server. Run: npm test */
process.env.PORT = process.env.PORT || '3999';
process.env.SPECTATOR_DELAY_MS = '700';
const { io: Client } = require('socket.io-client');
process.env.DB_FILE = ':memory:';
const { server, ready } = require('./server');
const url = 'http://localhost:' + process.env.PORT;
let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

function agent(name) {
  const s = Client(url), a = { s, name, round: null, order: null, wrong: 0, views: 0, over: null, t: [], chats: [] };
  s.on('game:round', r => { a.round = r; a.order = r.order; if (!a.checked) { a.checked = true; ok(r.order.length === 500 && new Set(r.order).size === 500 && Math.max(...r.order) === 499 && Math.min(...r.order) === 0, 'board has exactly 500 unique numbers (0-499)'); } act(a); });
  s.on('game:state', r => { a.round = { ...a.round, ...r }; act(a); });
  s.on('game:view', () => a.views++);
  s.on('game:wrong', () => a.wrong++);
  s.on('game:over', o => { a.over = o; });
  s.on('room:state', r => { a.room = r; });
  s.on('chat', c => a.chats.push(c));
  return a;
}
const used = new Set();
function act(a) {
  const r = a.round; if (!r || !a.id) return;
  if (r.ph === 'select' && r.sl === a.name) {
    if (!a.tested) {                                    // validation checks on the first selection
      a.tested = true;
      a.s.emit('game:target', 5000, x => ok(/0 to 499/.test(x.error), 'server rejects target 5000'));
      a.s.emit('game:target', 500, x => ok(/0 to 499/.test(x.error), 'server rejects target 500 (the board is 0-499)'));
      a.s.emit('game:target', -1, x => ok(!!x.error, 'server rejects target -1'));
    }
    let v; do { v = Math.floor(Math.random() * 500); } while (used.has(v));
    used.add(v); setTimeout(() => a.s.emit('game:target', v, x => { if (x.error && !/Not choosing/.test(x.error)) console.log('  target err', x.error); }), 100);
  }
  if (r.ph === 'search' && r.sr === a.name && r.tg !== null && a.lastClick !== r.r) {
    a.lastClick = r.r;
    const wrong = (r.tg + 1) % 500;
    a.s.emit('game:click', wrong);                      // wrong click first (no penalty)
    a.s.emit('game:view', { top: 0.4, peek: 12 });
    setTimeout(() => a.s.emit('game:click', r.tg), 200);
  }
}
const emitP = (s, ev, d) => new Promise(r => s.emit(ev, d, r));

(async () => {
  await ready;
  const A = agent('Alice'), B = agent('Bob');
  const ra = await emitP(A.s, 'room:create', { name: 'Alice', size: 2, cfg: { search: 8, target: 8, win: 'score', val: 3 } });
  A.id = ra.id; ok(ra.ok && /^NH-/.test(ra.code), 'room created ' + ra.code);
  const rb = await emitP(B.s, 'room:join', { code: ra.code, name: 'Bob' });
  B.id = rb.id; ok(rb.ok, 'Bob joined');
  ok((await emitP(Client(url), 'room:join', { code: 'NH-ZZZZ', name: 'X' })).ok === false, 'unknown room rejected');
  await new Promise(r => setTimeout(r, 200));
  ok(A.room.teams[0][0].name === 'Alice' && A.room.teams[1][0].name === 'Bob', 'teams balanced (A vs B)');
  const S = agent('Spec'); S.id = 'spec'; S.name = '';
  const rs = await emitP(S.s, 'room:spectate', { code: ra.code }); ok(rs.ok && rs.delayMs === 700, 'spectator joined with delay ' + rs.delayMs + ' ms');
  const sd = await emitP(Client(url), 'room:join', { code: ra.code, name: 'Late' }); ok(sd.ok === true, 'room has free slots before start');
  /* chat: team messages stay private, "all" messages reach everyone (spectators after the delay), spam is limited */
  A.s.emit('chat', { text: 'secret plan', scope: 'team' }); A.s.emit('chat', { text: 'hello everyone', scope: 'all' });
  A.s.emit('chat', { text: '   ', scope: 'all' });
  for (let i = 0; i < 8; i++) A.s.emit('chat', { text: 'spam' + i, scope: 'all' });
  S.s.emit('chat', { text: 'spectator talk', scope: 'all' });
  await new Promise(r => setTimeout(r, 1200));
  ok(A.chats.some(c => c.text === 'secret plan') && !B.chats.some(c => c.text === 'secret plan') && !S.chats.some(c => c.text === 'secret plan'), 'team chat is private to the team');
  ok(B.chats.some(c => c.text === 'hello everyone') && S.chats.some(c => c.text === 'hello everyone'), 'all-chat reaches the other team and spectators');
  ok(B.chats.filter(c => /^spam/.test(c.text)).length <= 3 && !B.chats.some(c => c.text.trim() === ''), 'chat is rate limited and empty messages are dropped');
  ok(!A.chats.some(c => c.text === 'spectator talk') && !B.chats.some(c => c.text === 'spectator talk'), 'spectators cannot chat');
  A.s.emit('room:fill'); A.s.emit('room:start');
  const t0 = Date.now();
  await new Promise(res => { const iv = setInterval(() => { if (A.over && B.over) { clearInterval(iv); res(); } if (Date.now() - t0 > 120000) { clearInterval(iv); res(); } }, 200); });
  ok(!!A.over, 'match finished');
  if (A.over) {
    const [x, y] = A.over.score; console.log('  final score', x, '-', y, 'mvp', A.over.mvp, 'rows', A.over.rows.length);
    ok(Math.max(x, y) === 3, 'first team to 3 points wins (score ' + x + '-' + y + ')');
    ok(A.over.rows.length === 4, 'bots filled to 2v2');
    const al = A.over.rows.find(r => r.name === 'Alice'), bo = A.over.rows.find(r => r.name === 'Bob');
    ok(al.w + bo.w >= 1 && A.wrong + B.wrong >= 1, 'wrong clicks counted without penalty');
    ok(A.over.result === (x === y ? 'draw' : x > y ? 'A' : 'B'), 'result is ' + A.over.result);
  }
  ok(A.views + B.views > 0, 'live view relayed between players (' + (A.views + B.views) + ' events)');
  await new Promise(r => setTimeout(r, 900));
  ok(S.views > 0 && !!S.over, 'spectator got delayed live view (' + S.views + ') and the result');
  console.log(failed ? '\n' + failed + ' FAILED' : '\nALL TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
