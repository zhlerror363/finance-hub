// backup-db.js -- finance-hub offline snapshot using node:sqlite VACUUM INTO
// Usage: node scripts\backup-db.js <src.db> <dst.db>
// Bypasses running finance-hub service and never writes to the source db: the
// source is opened read-only, which still permits VACUUM INTO. (W79: a
// read-write connection would checkpoint the WAL into the source and delete
// its -wal sidecar on close, mutating a live/archival database.)
const fs = require('node:fs');
const path = require('node:path');

const src = process.argv[2];
const dst = process.argv[3];
if (!src || !dst) {
  console.error('Usage: node backup-db.js <src.db> <dst.db>');
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error('Source not found:', src);
  process.exit(2);
}

// Strategy: try VACUUM INTO via a fresh node:sqlite connection.
// node:sqlite since Node 22 supports VACUUM INTO.
(async () => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (e) {
    console.error('node:sqlite not available. Need Node 22.5+.');
    process.exit(3);
  }
  try {
    const db = new sqlite.DatabaseSync(src, { readOnly: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    // VACUUM INTO produces a consistent snapshot even if the source is being written to.
    db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
    db.close();
    const sz = fs.statSync(dst).size;
    console.log(`OK: snapshot -> ${dst} (${sz} bytes)`);
    process.exit(0);
  } catch (e) {
    console.error('VACUUM INTO failed:', e.message);
    process.exit(4);
  }
})();