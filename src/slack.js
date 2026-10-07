// Slack OAuth v2 with *user* scopes, so we read what you see (DMs, mentions) as you.
const READ_SCOPES = [
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'users:read', 'users:read.email', 'search:read', 'team:read',
];
const USER_SCOPES = { read: READ_SCOPES, write: [...READ_SCOPES, 'chat:write'] };

const redirectUri = base => `${base}/auth/slack/callback`;

function authUrl(base, state, { access = 'read' } = {}) {
  const p = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    user_scope: (USER_SCOPES[access] || READ_SCOPES).join(','),
    redirect_uri: redirectUri(base),
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${p}`;
}

async function exchangeCode(base, code) {
  const r = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code, redirect_uri: redirectUri(base),
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack oauth error: ${j.error}`);
  return j;
}

async function api(token, method, params = {}, tries = 3) {
  const r = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 429) {
    // Short waits are fine; long ones (Slack's 1/min limits) would stall the whole read, so fail fast.
    const wait = Number(r.headers.get('retry-after')) || 2;
    if (wait > 10 || tries <= 0) throw new Error(`Slack is rate-limiting ${method} (retry in ${wait}s)`);
    await new Promise(ok => setTimeout(ok, wait * 1000));
    return api(token, method, params, tries - 1);
  }
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

// Post as the user (needs the chat:write user scope).
async function post(token, method, body) {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error === 'missing_scope' ? 'Reconnect this Slack workspace (Settings → + Slack) to allow sending.' : `Slack ${method}: ${j.error}`);
  return j;
}

module.exports = { authUrl, exchangeCode, api, post };
