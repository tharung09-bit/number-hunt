/* 1v1 mode, selectable board sizes, and quick-match queues that keep board sizes apart. */
process.env.PORT = process.env.PORT || '3974';
process.env.DB_FILE = ':memory:';
process.env.SPECTATOR_DELAY_MS = '200';
const { io: Client } = require('socket.io-client');
const { ready } = require('./server');
const url = 'http://localhost:' + process.env.PORT;
let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const emitP = (s, ev, d) => new Promise(r => s.emit(ev, d, r));
const used = new Set();

function agent(name) {
  const s = Client(url), a = { s, name, round: null, order: null, over: null, room: null, matched: null };
  s.on('game:round', r => { a.round = r; a.order = r.order; act(a); });
  s.on('game:state', r => { a.round = { ...a.round, ...r }; act(a); });
  s.on('game:over', o => { a.over = o; });
  s.on('room:state', r => { a.room = r; });
  s.on('queue:matched', m => { a.matched = m; });
  return a;
}
function act(a) {
  const r = a.round; if (!r || !a.ready) return;
  if (r.ph === 'select' && r.sl === a.name) {
    let v; do { v = Math.floor(Math.random() * r.cfg.board); } while (used.has(v)); used.add(v);
    setTimeout(() => a.s.emit('game:target', v, () => {}), 80);
  }
  if (r.ph === 'search' && r.sr === a.name && r.tg !== null && a.last !== r.r) { a.last = r.r; setTimeout(() => a.s.emit('game:click', r.tg), 150); }
}

(async () => {
  await ready;
  // ---- 1v1 with a 150-number board ----
  const A = agent('Alice'), B = agent('Bobby');
  const ra = await emitP(A.s, 'room:create', { name: 'Alice', size: 1, cfg: { search: 8, target: 8, win: 'score', val: 2, board: 150 } });
  ok(ra.ok, '1v1 room created');
  const rb = await emitP(B.s, 'room:join', { code: ra.code, name: 'Bobby' }); ok(rb.ok, 'second player joined');
  const rc = await emitP(Client(url), 'room:join', { code: ra.code, name: 'Third' }); ok(rc.ok === false && /full/i.test(rc.error), '1v1 room is full after two players');
  await wait(200);
  ok(A.room.size === 1 && A.room.cfg.board === 150 && A.room.teams[0].length === 1 && A.room.teams[1].length === 1, 'room reports 1v1 and a 150-number board');
  A.s.emit('room:start');
  let first = true, t0 = Date.now();
  while (!(A.over && B.over) && Date.now() - t0 < 120000) {
    await wait(150);
    if (first && A.round && A.order) {
      first = false;
      ok(A.order.length === 150 && new Set(A.order).size === 150 && Math.max(...A.order) === 149 && Math.min(...A.order) === 0, 'board has exactly 150 unique numbers (0-149)');
      const sel = A.round.sl === 'Alice' ? A : B;
      ok(/0 to 149/.test((await emitP(sel.s, 'game:target', 150, x => x)).error || ''), 'target 150 rejected on a 150-number board');
      ok(!!(await emitP(sel.s, 'game:target', -1)).error, 'target -1 rejected');
      A.ready = B.ready = true; act(A); act(B);                       // now let the players play normally
    }
  }
  ok(!!A.over, '1v1 match finished');
  if (A.over) {
    ok(A.over.rows.length === 2 && A.over.rows.every(r => !/^(Kuro|Raiden|Mochi|Vex|Lyra|Orion|Echo|Blitz|Sora|Ryu|Nova|Zed)$/.test(r.name)), '1v1 has exactly two players, no bots added');
    ok(Math.max(...A.over.score) === 2 && A.over.rows.some(r => r.c >= 1), 'score reached the target (' + A.over.score.join('-') + ') and both rotations ran');
  }
  // ---- invalid board size falls back to 500 ----
  const C = agent('Cara'); const rd = await emitP(C.s, 'room:create', { name: 'Cara', size: 2, cfg: { board: 123456 } }); await wait(150);
  ok(C.room.cfg.board === 500, 'unknown board size falls back to 500');
  const D = agent('Dan'); await emitP(D.s, 'room:create', { name: 'Dan', size: 2, cfg: { board: 1000 } }); await wait(150);
  ok(D.room.cfg.board === 1000, '1000-number board is allowed');
  // ---- quick match keeps board sizes apart ----
  const P1 = agent('P1'), P2 = agent('P2'), P3 = agent('P3'), P4 = agent('P4');
  P1.s.emit('queue:join', { name: 'P1', size: 1, board: 250 }); P2.s.emit('queue:join', { name: 'P2', size: 1, board: 250 });
  P3.s.emit('queue:join', { name: 'P3', size: 1, board: 350 });
  await wait(1800);
  ok(P1.matched && P2.matched && !P3.matched, 'two players with the same size and board are matched; a different board waits');
  ok(P1.room && P1.room.size === 1 && P1.room.cfg.board === 250, 'matched room is 1v1 with 250 numbers');
  P4.s.emit('queue:join', { name: 'P4', size: 1, board: 350 }); await wait(1800);
  ok(P3.matched && P4.matched && P3.room.cfg.board === 350, 'players who chose 350 are matched together');
  console.log(failed ? '\n' + failed + ' FAILED' : '\nALL MODE TESTS PASSED');
  process.exit(failed ? 1 : 0);
})();
