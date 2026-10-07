// Google OAuth (popup) + token refresh. Plain fetch, no googleapis dependency.
// access 'read' → read mail only; 'write' → also send replies you approve.
const SCOPES = {
  read: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly'],
  write: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
};
const canSend = scope => /gmail\.(send|modify|compose)|mail\.google\.com/.test(scope || '');

const redirectUri = base => `${base}/auth/google/callback`;

// login=true → identity only (who is signing in to into-one); otherwise Gmail access with offline refresh token.
function authUrl(base, state, { login = false, access = 'read' } = {}) {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(base),
    response_type: 'code',
    scope: (login ? ['openid', 'email', 'profile'] : SCOPES[access] || SCOPES.read).join(' '),
    ...(login
      ? { prompt: 'select_account' }
      : { access_type: 'offline', prompt: 'consent select_account' }),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google token error: ${j.error_description || j.error}`);
  return { ...j, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
}

const exchangeCode = (base, code) => tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(base) });

async function userInfo(accessToken) {
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
  return r.json();
}

// Returns a valid access token, refreshing (and persisting) when expired.
async function accessToken(store, acc) {
  const t = store.getTokens(acc);
  if (t.expires_at > Date.now()) return t.access_token;
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
  await store.setTokens(acc, { ...t, ...fresh });
  return fresh.access_token;
}

async function gmail(store, acc, path, body) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await accessToken(store, acc)}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail ${path}: ${j.error?.message || r.status}`);
  return j;
}

const encWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const hdr = (m, n) => m.payload?.headers?.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

// Reply inside an existing thread: to the last person who wrote (not you), keeping their CCs.
async function replyInThread(store, acc, threadId, text) {
  const me = acc.meta.email.toLowerCase();
  const th = await gmail(store, acc, `threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Reply-To`);
  const last = [...th.messages].reverse().find(m => !(m.labelIds || []).includes('SENT')) || th.messages[th.messages.length - 1];
  const addr = v => (v.match(/<([^>]+)>/)?.[1] || v).trim().toLowerCase();
  const to = hdr(last, 'Reply-To') || hdr(last, 'From');
  const cc = [hdr(last, 'To'), hdr(last, 'Cc')].join(',').split(',').map(x => x.trim()).filter(x => x && addr(x) !== me && addr(x) !== addr(to));
  const subject = hdr(last, 'Subject');
  const msgId = hdr(last, 'Message-ID');
  const mime = [
    `From: ${acc.meta.name ? `${encWord(acc.meta.name)} <${acc.meta.email}>` : acc.meta.email}`,
    `To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encWord(/^re:/i.test(subject) ? subject : `Re: ${subject}`)}`,
    ...(msgId ? [`In-Reply-To: ${msgId}`, `References: ${[hdr(last, 'References'), msgId].filter(Boolean).join(' ')}`] : []),
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(text).toString('base64').replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  const sent = await gmail(store, acc, 'messages/send', { raw: Buffer.from(mime).toString('base64url'), threadId });
  return { id: sent.id, to: addr(to), cc: cc.map(addr) };
}

module.exports = { authUrl, exchangeCode, userInfo, accessToken, gmail, replyInThread, canSend };
