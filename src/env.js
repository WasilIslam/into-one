// Minimal .env loader: project .env wins over inherited env (shared .env is preloaded by clauder).
const fs = require('fs');
const path = require('path');

function load(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

load(path.join(__dirname, '..', '.env'));
if (process.env.SHARED_ENV_FILE) load(process.env.SHARED_ENV_FILE); // optional extra env file
load(path.join(__dirname, '..', '.env.local')); // DATABASE_URL etc. pulled from Vercel
