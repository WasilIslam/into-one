// Storage: Postgres (Neon) when DATABASE_URL is set, else a local JSON file.
// One jsonb row per collection; every request loads fresh state, so serverless instances stay in sync.
// Tokens are encrypted at rest with AES-256-GCM.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'db.json');
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
if (KEY.length !== 32) throw new Error('ENCRYPTION_KEY missing/invalid');

const COLLECTIONS = ['accounts', 'items', 'tasks', 'chat', 'feedback', 'mutes', 'magic'];
const db = Object.fromEntries(COLLECTIONS.map(k => [k, []]));

const sql = process.env.DATABASE_URL
  ? require('postgres')(process.env.DATABASE_URL, { ssl: 'require', max: 3, idle_timeout: 20, prepare: false, onnotice: () => {} })
  : null;
let ready = null;
const init = () => (ready ||= sql`create table if not exists kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now())`);

async function load(keys = COLLECTIONS) {
  if (!sql) {
    const data = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
    keys.forEach(k => { db[k] = data[k] || []; });
    return;
  }
  await init();
  const rows = await sql`select key, value from kv where key in ${sql(keys)}`;
  keys.forEach(k => { db[k] = rows.find(r => r.key === k)?.value || []; });
}

async function save(keys = COLLECTIONS) {
  if (!sql) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const data = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
    keys.forEach(k => { data[k] = db[k]; });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
    return;
  }
  await init();
  await sql.begin(tx => Promise.all(keys.map(k =>
    tx`insert into kv (key, value) values (${k}, ${tx.json(db[k])})
       on conflict (key) do update set value = excluded.value, updated_at = now()`)));
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

function decrypt(str) {
  const [iv, tag, data] = str.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

// Upsert by provider + external id so reconnecting an account refreshes it instead of duplicating.
async function upsertAccount({ provider, externalId, label, meta, tokens, access }) {
  await load(['accounts']);
  let acc = db.accounts.find(a => a.provider === provider && a.externalId === externalId);
  if (!acc) {
    acc = { id: crypto.randomUUID(), provider, externalId, createdAt: new Date().toISOString() };
    db.accounts.push(acc);
  }
  Object.assign(acc, { label, meta, access, tokens: encrypt(tokens), status: 'connected', updatedAt: new Date().toISOString() });
  await save(['accounts']);
  return acc;
}

const publicAccount = ({ tokens, ...a }) => a;

module.exports = {
  db, load, save, encrypt, decrypt, upsertAccount, publicAccount, COLLECTIONS, sql,
  getTokens: acc => decrypt(acc.tokens),
  setTokens: async (acc, t) => { acc.tokens = encrypt(t); await save(['accounts']); },
  removeAccount: async id => {
    db.accounts = db.accounts.filter(a => a.id !== id);
    db.tasks = db.tasks.filter(t => t.accountId !== id);
    await save(['accounts', 'tasks']);
  },
};
