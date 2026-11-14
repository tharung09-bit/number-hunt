/* Upgrading an old database: users created before Player IDs existed get one automatically. */
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'nh-mig-' + Date.now() + '.db');
const { DatabaseSync } = require('node:sqlite');
const old = new DatabaseSync(process.env.DB_FILE);
old.exec("CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT UNIQUE, username TEXT UNIQUE, pwd TEXT, gsub TEXT UNIQUE, name TEXT, avatar TEXT, bio TEXT, created BIGINT)");
old.prepare("INSERT INTO users(id,email,username,created) VALUES('u1','a@x.com','OldUser',1),('u2','b@x.com','OldTwo',2)").run(); old.close();
(async () => {
  const A = await require('./accounts')();
  const a = await A.user('u1'), b = await A.user('u2');
  const ok = /^\d{9}$/.test(a.pid) && /^\d{9}$/.test(b.pid) && a.pid !== b.pid;
  console.log((ok ? 'PASS' : 'FAIL') + ' old accounts were given Player IDs (' + a.pid + ', ' + b.pid + ')');
  const again = await require('./accounts')();
  console.log(((await again.user('u1')).pid === a.pid ? 'PASS' : 'FAIL') + ' IDs stay the same after a restart');
  process.exit(ok ? 0 : 1);
})();
