// Records as files: one JSON file per account, character and table entry
// (data/accounts/<login>.json, data/characters/<id>.json,
// data/tables/<table>/<key>.json, data/meta.json). Only the records that
// changed are written, each atomically (temp file + rename), without blocking
// the game: the old single gomp-rp.json was written whole on every change.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const LEGACY = 'gomp-rp.json';

// File names: logins are [a-z0-9_]; table keys are encoded to stay safe.
const fileName = (key) => `${encodeURIComponent(key)}.json`;
const keyOf = (file) => decodeURIComponent(file.slice(0, -5));

class FileBackend {
  constructor(dir, { log = console } = {}) {
    this.dir = dir;
    this.log = log;
    this.kind = 'file';
  }

  _pathOf(key) {
    if (key === 'meta') return path.join(this.dir, 'meta.json');
    const [kind, ...rest] = key.split(':');
    if (kind === 'acc') return path.join(this.dir, 'accounts', fileName(rest.join(':')));
    if (kind === 'char') return path.join(this.dir, 'characters', fileName(rest.join(':')));
    if (kind === 't') return path.join(this.dir, 'tables', rest[0], fileName(rest.slice(1).join(':')));
    throw new Error(`storage: unknown record ${key}`);
  }

  // Every record as [key, value]. Synchronous: the gamemode needs its data
  // before it starts. A gomp-rp.json from before is moved over first.
  loadSync() {
    fs.mkdirSync(this.dir, { recursive: true });
    const legacy = path.join(this.dir, LEGACY);
    if (!fs.existsSync(path.join(this.dir, 'meta.json')) && fs.existsSync(legacy)) return this._migrate(legacy);
    const out = [];
    const read = (file, key) => {
      try {
        out.push([key, JSON.parse(fs.readFileSync(file, 'utf8'))]);
      } catch (e) {
        // A broken record is skipped (and kept on disk for a look), not fatal.
        this.log.error(`[storage] ${file}: ${e.message}`);
      }
    };
    const meta = path.join(this.dir, 'meta.json');
    if (fs.existsSync(meta)) read(meta, 'meta');
    for (const [folder, prefix] of [['accounts', 'acc'], ['characters', 'char']]) {
      const d = path.join(this.dir, folder);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) read(path.join(d, f), `${prefix}:${keyOf(f)}`);
    }
    const tables = path.join(this.dir, 'tables');
    if (fs.existsSync(tables)) {
      for (const t of fs.readdirSync(tables)) {
        const d = path.join(tables, t);
        if (!fs.statSync(d).isDirectory()) continue;
        for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) read(path.join(d, f), `t:${t}:${keyOf(f)}`);
      }
    }
    return out;
  }

  // gomp-rp.json -> records; the old file stays as gomp-rp.json.bak.
  _migrate(legacy) {
    const db = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const out = [];
    const meta = {};
    for (const [k, v] of Object.entries(db)) {
      if (k === 'accounts') for (const [login, acc] of Object.entries(v || {})) out.push([`acc:${login}`, acc]);
      else if (k === 'characters') for (const [id, ch] of Object.entries(v || {})) out.push([`char:${id}`, ch]);
      else if (v && typeof v === 'object' && !Array.isArray(v)) for (const [key, rec] of Object.entries(v)) out.push([`t:${k}:${key}`, rec]);
      else meta[k] = v;
    }
    out.push(['meta', meta]);
    for (const [key, value] of out) {
      const file = this._pathOf(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value, null, 1));
    }
    fs.renameSync(legacy, `${legacy}.bak`);
    this.log.log(`[storage] ${LEGACY} moved to ${out.length} files (old file: ${LEGACY}.bak)`);
    return out;
  }

  // changes: [{ key, json }] (json null: delete). Rejects when a write fails.
  async write(changes) {
    await Promise.all(changes.map((c) => this._writeOne(c.key, c.json)));
  }

  async _writeOne(key, json) {
    const file = this._pathOf(key);
    if (json === null) {
      await fsp.rm(file, { force: true });
      return;
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, json);
    // Windows: a reader (antivirus, backup) may hold the file for a moment.
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (e) {
        if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 20 * (i + 1)));
      }
    }
  }

  // Shutdown: the last changes written before the process ends.
  writeSync(changes) {
    for (const c of changes) {
      const file = this._pathOf(c.key);
      if (c.json === null) {
        fs.rmSync(file, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, c.json);
      fs.renameSync(tmp, file);
    }
  }

  close() {}
}

module.exports = { FileBackend, LEGACY };
