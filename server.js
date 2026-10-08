require('./src/env');
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const store = require('./src/store');
const auth = require('./src/auth');
const google = require('./src/google');
const slack = require('./src/slack');
const scan = require('./src/scan');
const ai = require('./src/ai');

const app = express();
const PORT = process.env.INTO_ONE_PORT || 4100;
const BASE = process.env.PUBLIC_URL || `https://localhost:${PORT}`;
const page = f => (_req, res) => res.sendFile(path.join(__dirname, 'views', f));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1d' })); // logo, icons, robots, sitemap
app.get('/api/health', (_req, res) => res.json({ ok: true, ai: !!process.env.OPENAI_API_KEY, db: !!store.sql }));
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.get('/login', page('landing.html')); // the landing page opens its sign-in box on /login

// ---- Sign in to into-one (Google, allow-listed emails only) -------------
app.get('/auth/login', (_req, res) => res.redirect(google.authUrl(BASE, auth.newState(res, 'login'), { login: true })));
app.get('/auth/logout', (_req, res) => { auth.endSession(res); res.redirect('/login'); });

// ---- Sign in with an emailed link (no password) --------------------------
const LINK_TTL = 15 * 60e3;
const shell = body => `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><head><meta charset="utf-8"><title>into-one</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{background:#f4f1e8;font-family:"IBM Plex Sans", Verdana, Arial, sans-serif;font-size:15px}.page{max-width:560px;margin:60px auto}.box{background:#fff;border:2px outset #ccc;padding:16px 20px}
button{font:inherit;padding:4px 14px;background:#e0e0e0;border:2px outset #fff;cursor:pointer}</style></head><body><div class="page"><div class="box">${body}</div></div></body></html>`;

app.use('/auth/email', express.urlencoded({ extended: false }));

// Same answer whether or not the email is allowed, so the page can't be used to probe addresses.
app.post('/auth/email', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
    if (auth.allowed(email)) {
      await store.load(['magic']);
      const now = Date.now();
      store.db.magic = store.db.magic.filter(m => m.exp > now);
      if (!store.db.magic.some(m => m.email === email && now - m.at < 60e3)) { // one link per minute per email
        const nonce = crypto.randomBytes(16).toString('hex');
        store.db.magic.push({ nonce, email, at: now, exp: now + LINK_TTL });
        await store.save(['magic']);
        await require('./src/mail').sendSignInLink(email, `${BASE}/auth/email/verify?t=${encodeURIComponent(auth.sign({ purpose: 'magic', email, nonce, exp: now + LINK_TTL }))}`);
      }
    }
    res.redirect('/login?sent=1');
  } catch (e) {
    console.error(e);
    res.redirect('/login?error=' + encodeURIComponent('Could not send the email, try again.'));
  }
});

// Opening the link only shows a button; the POST signs in. Mail scanners that prefetch links can't burn it.
app.get('/auth/email/verify', (req, res) => {
  const p = auth.verify(req.query.t);
  if (!p || p.purpose !== 'magic') return res.status(400).send(shell('This link is invalid or expired. <a href="/login">Get a new one</a>.'));
  res.send(shell(`<form method="post"><input type="hidden" name="t" value="${String(req.query.t).replace(/"/g, '&quot;')}">
    <p>Sign in to <b>into-one</b> as <b>${p.email}</b>?</p><button type="submit">Sign in</button></form>`));
});

app.post('/auth/email/verify', async (req, res) => {
  const p = auth.verify(req.body.t);
  if (!p || p.purpose !== 'magic' || !auth.allowed(p.email)) return res.status(400).send(shell('This link is invalid or expired. <a href="/login">Get a new one</a>.'));
  await store.load(['magic']);
  const link = store.db.magic.find(m => m.nonce === p.nonce && m.exp > Date.now());
  if (!link) return res.status(400).send(shell('This link was already used. <a href="/login">Get a new one</a>.'));
  store.db.magic = store.db.magic.filter(m => m !== link);
  await store.save(['magic']);
  auth.startSession(res, p.email);
  res.redirect('/');
});

// Popup lands here after connecting an account; it notifies the opener and closes itself.
const popupDone = (res, payload) => res.send(`<!doctype html><body style="font-family:Verdana,Arial,sans-serif;background:#f4f1e8;display:grid;place-items:center;height:100vh">
<div>${payload.ok ? 'Connected ' + (payload.label || '') : 'Error: ' + payload.error}</div>
<script>try{opener&&opener.postMessage(${JSON.stringify({ type: 'into-one:connected', ...payload })}, location.origin)}catch(e){}setTimeout(()=>window.close(),${payload.ok ? 900 : 4000})</script></body>`);

// One Google redirect URI serves both "sign in" and "connect Gmail".
app.get('/auth/google/callback', async (req, res) => {
  const st = auth.checkState(req, req.query.state);
  const purpose = st?.purpose;
  if (purpose === 'login') {
    try {
      if (req.query.error) throw new Error(req.query.error);
      const tokens = await google.exchangeCode(BASE, req.query.code);
      const me = await google.userInfo(tokens.access_token);
      if (!me.email_verified || !auth.allowed(me.email)) return res.status(403).send(`${me.email} is not allowed. <a href="/auth/login">Try another account</a>`);
      auth.startSession(res, me.email);
      return res.redirect('/');
    } catch (e) {
      return res.status(400).send(`Sign-in failed: ${e.message}. <a href="/login">Back</a>`);
    }
  }
  try {
    if (req.query.error) throw new Error(req.query.error);
    if (purpose !== 'google' || !auth.session(req)) throw new Error('Session expired, try again');
    const tokens = await google.exchangeCode(BASE, req.query.code);
    const me = await google.userInfo(tokens.access_token);
    // Access is what you chose, capped by what Google actually granted.
    const access = st.access === 'write' && google.canSend(tokens.scope) ? 'write' : 'read';
    const acc = await store.upsertAccount({
      provider: 'gmail', externalId: me.sub, label: me.email,
      meta: { email: me.email, name: me.name, picture: me.picture }, tokens, access,
    });
    popupDone(res, { ok: true, provider: 'gmail', label: acc.label });
  } catch (e) {
    popupDone(res, { ok: false, error: e.message });
  }
});

app.get('/auth/slack/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(req.query.error);
    const st = auth.checkState(req, req.query.state);
    if (st?.purpose !== 'slack' || !auth.session(req)) throw new Error('Session expired, try again');
    const r = await slack.exchangeCode(BASE, req.query.code);
    const u = r.authed_user;
    const info = await slack.api(u.access_token, 'users.info', { user: u.id });
    const acc = await store.upsertAccount({
      provider: 'slack', externalId: `${r.team.id}:${u.id}`, label: `${r.team.name} · @${info.user.name}`,
      meta: { team: r.team, userId: u.id, name: info.user.real_name, picture: info.user.profile?.image_72 },
      tokens: { access_token: u.access_token, refresh_token: u.refresh_token, expires_at: u.expires_in ? Date.now() + u.expires_in * 1000 : null },
      access: st.access === 'write' && (u.scope || '').includes('chat:write') ? 'write' : 'read',
    });
    popupDone(res, { ok: true, provider: 'slack', label: acc.label });
  } catch (e) {
    popupDone(res, { ok: false, error: e.message });
  }
});

// ---- Everything below requires a session --------------------------------
app.use((req, res, next) => {
  if (auth.session(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
  if (req.path === '/') return res.sendFile(path.join(__dirname, 'views', 'landing.html')); // signed-out visitors see the landing page
  res.redirect('/login');
});

// Fresh state from the DB on every request (serverless instances share nothing in memory).
app.use(async (_req, _res, next) => { try { await store.load(); next(); } catch (e) { next(e); } });

app.get('/', page('index.html'));
// ?access=read|write — chosen in the app before the sign-in window opens.
const accessOf = req => (req.query.access === 'write' ? 'write' : 'read');
app.get('/auth/google/start', (req, res) => res.redirect(google.authUrl(BASE, auth.newState(res, 'google', { access: accessOf(req) }), { access: accessOf(req) })));
app.get('/auth/slack/start', (req, res) => res.redirect(slack.authUrl(BASE, auth.newState(res, 'slack', { access: accessOf(req) }), { access: accessOf(req) })));

// ---- Accounts ----------------------------------------------------------
app.delete('/api/accounts/:id', async (req, res) => {
  await store.removeAccount(req.params.id);
  res.json({ ok: true });
});

// ---- Chat + tasks ------------------------------------------------------
app.get('/api/state', (req, res) => res.json({
  me: auth.session(req).email,
  accounts: store.db.accounts.map(store.publicAccount),
  tasks: store.db.tasks,
  mutes: store.db.mutes,
  chat: store.db.chat.slice(-50),
}));

// "read last 6 hours", "check slack since 3h", "today" → scan. Anything else → question about scanned messages.
function parseScan(text) {
  const t = text.toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/);
  let hours = m ? (m[2].startsWith('m') ? Number(m[1]) / 60 : Number(m[1])) : null;
  // Only an explicit "read/scan/fetch… messages" request triggers a read; task commands ("mark the email tasks done") don't.
  const readVerb = /\b(read|scan|fetch|pull|sync|refresh|catch me up|what'?s new)\b/.test(t) || /\bcheck (my |the )?(inbox|messages|emails?|mail|slack|gmail)\b/.test(t);
  const taskVerb = /\b(mark|done|complete|ignore|hide|rename|due|priority|remind|add (a )?task|create|delete|move|snooze|reopen|note)\b/.test(t);
  if (taskVerb && (!readVerb || /\btasks?\b/.test(t))) return null;
  if (!hours && /\b(today|yesterday|overnight|last day|24h)\b/.test(t) && readVerb) hours = 24;
  if (!hours && /\b(morning)\b/.test(t) && readVerb) hours = Math.max(1, new Date().getHours() - 6);
  if (hours && !readVerb && !/^\s*(last|past)?\s*[\d.]+\s*(h|hr|hrs|hours?|m|mins?|minutes)\s*$/.test(t)) return null;
  if (!hours && !readVerb) return null;
  const only = /slack/.test(t) && !/gmail|email|mail/.test(t) ? 'slack' : /gmail|email|mail/.test(t) && !/slack/.test(t) ? 'gmail' : null;
  return { hours: hours || 24, only, capped: hours > scan.MAX_HOURS };
}

const SKIP_LABELS = {
  newsletter: 'newsletters/promos', you_replied_last: 'you replied last', just_ack: 'just "ok/thanks"',
  bot: 'bot messages', chatter: 'channel chatter not about you', muted: 'muted senders', ai_ignored: 'AI: nothing for you', empty: 'empty',
};

function scanReport(r, p) {
  const h = r.hours < 1 ? `${Math.round(r.hours * 60)} min` : `${+r.hours.toFixed(1)}h`;
  const bits = [];
  if (r.created.length) bits.push(`${r.created.length} new`);
  if (r.updated.length) bits.push(`${r.updated.length} updated`);
  if (r.closed.length) bits.push(`${r.closed.length} auto-closed`);
  const errs = r.accounts.filter(a => a.error).map(a => `\n${a.label}: ${a.error}`).join('');
  return `${p.capped ? '(max is 24h) ' : ''}Read last ${h}. ${bits.length ? bits.join(', ') + '.' : 'Nothing new needs you.'}${errs}`;
}

const say = async (role, text, data) => {
  await store.load(['chat']);
  const msg = { role, text, data, at: new Date().toISOString() };
  store.db.chat = [...store.db.chat, msg].slice(-200);
  await store.save(['chat']);
  return msg;
};

app.post('/api/chat', async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  await say('you', text);
  try {
    const p = parseScan(text);
    if (p) {
      const r = await scan.run(p);
      if (r.error) return res.json(await say('bot', r.error));
      return res.json(await say('bot', scanReport(r, p), {
        created: r.created.map(t => t.id), closed: r.closed.map(t => ({ title: t.title, why: t.autoNote })),
        fyi: r.fyi, skippedList: r.skippedList,
        hidden: Object.entries(r.skipped).filter(([, n]) => n).map(([k, n]) => `${n} ${SKIP_LABELS[k] || k}`).join(', '),
      }));
    }
    // Short ids ("t1") keep the prompt small and stop the model inventing task ids.
    const recent = store.db.tasks.filter(t => t.status === 'open' || Date.now() - Date.parse(t.doneAt || 0) < 3 * 86400e3);
    const byId = Object.fromEntries(recent.map((t, i) => [`t${i + 1}`, t]));
    const context = {
      conversations: store.db.items,
      tasks: Object.entries(byId).map(([id, t]) => ({ id, title: t.title, status: t.status, priority: t.priority, due: t.due, from: t.from, where: t.where, why: t.why, notes: t.comments.map(c => c.text) })),
      now: new Date().toISOString(),
    };
    const out = await ai.answer(text, context);
    const changes = applyActions(out.actions, { byId });
    if (changes.length) await store.save(['tasks', 'feedback']);
    res.json(await say('bot', [out.reply, ...changes].filter(Boolean).join('\n')));
  } catch (e) {
    res.json(await say('bot', 'Something went wrong: ' + e.message));
  }
});

const findTask = (req, res) => {
  const t = store.db.tasks.find(x => x.id === req.params.id);
  if (!t) res.status(404).json({ error: 'not found' });
  return t;
};

// status: open | done | ignored. Done/ignored are remembered and shown to the AI next time.
function setStatus(t, status, reason) {
  if (!status || status === t.status) return false;
  t.status = status;
  t.done = status !== 'open';
  t.doneAt = t.done ? new Date().toISOString() : null;
  t.ignoreReason = status === 'ignored' ? reason || null : null;
  t.autoNote = null;
  if (t.done) {
    store.db.feedback.push({ at: t.doneAt, action: status, reason: reason || null, title: t.title, type: t.type, from: t.from, where: t.where, summary: t.summary });
    store.db.feedback = store.db.feedback.slice(-200);
  }
  return true;
}

const TYPES = ['reply', 'do', 'fix', 'pay', 'review', 'meet', 'promise', 'fyi'];
const newTask = ({ title, due, priority }) => ({
  id: crypto.randomUUID(), title: String(title).slice(0, 140), type: 'do', priority: /^P[0-3]$/.test(priority) ? priority : 'P1',
  due: due || null, source: 'manual', status: 'open', done: false, comments: [], createdAt: new Date().toISOString(),
});

// Apply actions proposed by a chat. Returns human-readable lines describing what changed.
function applyActions(actions, { task, byId } = {}) {
  const done = [];
  for (const a of actions.slice(0, 10)) {
    if (!a || typeof a !== 'object') continue;
    if (a.op === 'create' && a.title) {
      const t = newTask(a);
      store.db.tasks.push(t);
      done.push(`+ Added task: ${t.title}${t.due ? ` (due ${t.due})` : ''}`);
      continue;
    }
    const t = task || (byId && byId[a.task]);
    if (!t) continue;
    if (a.op === 'done' && setStatus(t, 'done', 'from chat')) done.push(`✓ Marked done: ${t.title}`);
    else if (a.op === 'ignore' && setStatus(t, 'ignored', a.reason || 'from chat')) done.push(`– Hidden: ${t.title}`);
    else if (a.op === 'reopen' && setStatus(t, 'open')) done.push(`↺ Reopened: ${t.title}`);
    else if (a.op === 'note' && a.text) { t.comments.push({ text: String(a.text).slice(0, 500), at: new Date().toISOString() }); done.push(`✎ Note added to: ${t.title}`); }
    else if (a.op === 'update') {
      const changes = [];
      if (a.title && a.title !== t.title) { t.title = String(a.title).slice(0, 140); changes.push(`title → ${t.title}`); }
      if (a.due !== undefined && a.due !== t.due) { t.due = a.due || null; changes.push(`due → ${t.due || 'none'}`); }
      if (/^P[0-3]$/.test(a.priority) && a.priority !== t.priority) { t.priority = a.priority; changes.push(`priority → ${a.priority}`); }
      if (TYPES.includes(a.type) && a.type !== t.type) { t.type = a.type; changes.push(`type → ${a.type}`); }
      if (changes.length) { t.updatedAt = new Date().toISOString(); done.push(`✎ Updated ${task ? 'task' : `"${t.title}"`}: ${changes.join(', ')}`); }
    }
  }
  return done;
}

// Did the user actually ask for a message to be written? (Keeps plain answers out of the draft box.)
const DRAFT_ASK = /\b(repl(y|ies)|respond|draft|write|send|tell|message|text|email (him|her|them)|let (him|her|them) know|ask (him|her|them)|follow ?up|ping|say|answer (him|her|them)|shorter|longer|rephrase|reword|more (formal|casual|polite)|change (it|the draft)|mention)\b/i;

app.patch('/api/tasks/:id', async (req, res) => {
  const t = findTask(req, res); if (!t) return;
  const { status, reason } = req.body;
  setStatus(t, status, reason);
  if (reason === 'mute' && t.from) store.db.mutes.push({ id: t.from, label: `${t.from} (${t.where})`, at: new Date().toISOString() });
  await store.save(['tasks', 'feedback', 'mutes']);
  res.json(t);
});

// Chat about a single task. Gmail tasks re-read the live thread so addresses and new replies are included.
app.post('/api/tasks/:id/chat', async (req, res) => {
  const t = findTask(req, res); if (!t) return;
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  let source = t.context || null;
  try {
    if (t.source === 'gmail' && t.convKey) {
      const [, accId, threadId] = t.convKey.split(':');
      const acc = store.db.accounts.find(a => a.id === accId);
      if (acc) source = { subject: t.context?.subject, messages: (await scan.gmailThread(acc, threadId)).slice(-15) };
    }
  } catch (e) { console.error('task chat: live thread failed', e.message); }
  if (!source) source = store.db.items.find(i => i.key === t.convKey) || { note: 'No source conversation stored for this task.' };

  const history = t.chat || [];
  let reply, draft = null, actions = [];
  try { ({ reply, draft, actions } = await ai.taskAnswer(t, source, history, text)); } catch (e) { reply = 'Something went wrong: ' + e.message; }
  // A draft only when one was asked for (or a previous draft is being revised); otherwise show the text as a normal answer.
  const revising = [...history].reverse().find(m => m.role === 'bot')?.draft && !/\?\s*$/.test(text);
  if (draft && !DRAFT_ASK.test(text) && !revising) { reply = [reply, draft].filter(Boolean).join('\n\n'); draft = null; }

  // Re-read tasks before writing so a scan running at the same time isn't overwritten.
  await store.load(['tasks']);
  const fresh = store.db.tasks.find(x => x.id === t.id);
  if (!fresh) return res.status(404).json({ error: 'task deleted' });
  const now = new Date().toISOString();
  const changes = applyActions(actions || [], { task: fresh });
  const bot = { id: crypto.randomUUID(), role: 'bot', text: [reply, ...changes].filter(Boolean).join('\n'), at: new Date().toISOString(), ...(draft && t.convKey && { draft: { text: draft } }) };
  fresh.chat = [...(fresh.chat || []), { role: 'you', text, at: now }, bot].slice(-60);
  await store.save(['tasks', 'feedback']);
  res.json(fresh);
});

// Send a reply into the task's original conversation (Gmail thread or Slack DM/thread). Only ever on an explicit click.
app.post('/api/tasks/:id/send', async (req, res) => {
  const t = findTask(req, res); if (!t) return;
  const text = String(req.body.text || '').trim();
  const msg = (t.chat || []).find(m => m.id === req.body.messageId);
  if (!text || !msg?.draft) return res.status(400).json({ error: 'Nothing to send' });
  if (msg.draft.sentAt) return res.status(409).json({ error: 'Already sent' });
  const [kind, accId, a, b] = (t.convKey || '').split(':');
  const acc = store.db.accounts.find(x => x.id === accId);
  if (!acc) return res.status(400).json({ error: 'The account for this task is no longer connected' });
  if (acc.access !== 'write') return res.status(403).json({ error: `${acc.label} is read-only. Reconnect it with "Read & reply" in Settings to send.` });

  try {
    let sentTo;
    if (kind === 'g') {
      const r = await google.replyInThread(store, acc, a, text);
      sentTo = `email to ${[r.to, ...r.cc].join(', ')}`;
    } else {
      // Reply in the thread of the message this task is about (its existing thread, or a new one under it).
      const { access_token } = store.getTokens(acc);
      let target = t.replyTo || { channel: a, thread_ts: b };
      if (!target.thread_ts) {
        // Older tasks (DMs) didn't store a target: reply under the latest message from someone else.
        const h = await slack.api(access_token, 'conversations.history', { channel: a, limit: 15 });
        const last = h.messages.find(m => m.user && m.user !== acc.meta.userId);
        if (last) target = { channel: a, thread_ts: last.thread_ts || last.ts };
      }
      await slack.post(access_token, 'chat.postMessage', { channel: target.channel, text, ...(target.thread_ts && { thread_ts: target.thread_ts }) });
      sentTo = `Slack ${t.where}${target.thread_ts ? ' (in thread)' : ''}`;
    }
    Object.assign(msg.draft, { text, sentAt: new Date().toISOString(), sentTo });
    if (req.body.markDone && t.status === 'open') {
      Object.assign(t, { status: 'done', done: true, doneAt: msg.draft.sentAt, autoNote: `replied (${sentTo})` });
      store.db.feedback.push({ at: t.doneAt, action: 'done', reason: 'replied from into-one', title: t.title, type: t.type, from: t.from, where: t.where, summary: t.summary });
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
  await store.save(['tasks', 'feedback']);
  res.json(t);
});

app.delete('/api/tasks/:id/chat', async (req, res) => {
  const t = findTask(req, res); if (!t) return;
  t.chat = [];
  await store.save(['tasks']);
  res.json(t);
});

app.delete('/api/mutes/:i', async (req, res) => {
  store.db.mutes.splice(Number(req.params.i), 1);
  await store.save(['mutes']);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  const t = findTask(req, res); if (!t) return;
  const text = String(req.body.text || '').trim();
  if (text) t.comments.push({ text, at: new Date().toISOString() });
  await store.save(['tasks']);
  res.json(t);
});

app.post('/api/tasks', async (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'empty' });
  const t = newTask({ title, priority: req.body.priority });
  store.db.tasks.push(t);
  await store.save(['tasks']);
  res.json(t);
});

app.delete('/api/tasks/:id', async (req, res) => {
  store.db.tasks = store.db.tasks.filter(t => t.id !== req.params.id);
  await store.save(['tasks']);
  res.json({ ok: true });
});

app.post('/api/chat/clear', async (_req, res) => {
  store.db.chat = [];
  await store.save(['chat']);
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); });

module.exports = app;

// Local dev: HTTPS on localhost (Slack requires https redirects).
if (require.main === module) {
  const fs = require('fs');
  if (fs.existsSync('certs/localhost.pem')) {
    require('https')
      .createServer({ key: fs.readFileSync('certs/localhost-key.pem'), cert: fs.readFileSync('certs/localhost.pem') }, app)
      .listen(PORT, () => console.log(`into-one running → ${BASE}`));
  } else {
    // No local certs: plain HTTP works for Google, but Slack OAuth needs HTTPS (see README → Local development).
    app.listen(PORT, () => console.log(`into-one running → http://localhost:${PORT} (no certs/ found, Slack sign-in needs HTTPS)`));
  }
}
