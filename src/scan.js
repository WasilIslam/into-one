// Pull the last N hours (max 24) from every connected account, rebuild each *conversation*
// (including your own replies), filter the obvious stuff without AI, and let the AI
// decide only what's left: does this still need you?
const crypto = require('crypto');
const store = require('./store');
const google = require('./google');
const slack = require('./slack');
const rules = require('./rules');
const ai = require('./ai');
const { OWNER_NAME } = require('./owner');

const MAX_HOURS = 24;
const MAX_MSGS_PER_CONV = 12;

async function pool(list, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx]).catch(e => ({ error: e.message }));
    }
  }));
  return out;
}

const header = (msg, name) => msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const nameOf = from => (from.match(/^"?([^"<]+?)"?\s*</)?.[1] || from).trim();
const emailOf = from => (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();

// ---- Gmail -------------------------------------------------------------

function bodyText(payload) {
  const parts = [];
  const walk = p => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(payload);
  const dec = p => Buffer.from(p.body.data, 'base64url').toString('utf8');
  const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return dec(plain);
  const html = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
  return html ? dec(html).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : '';
}

// Only the new part of a reply: drop quoted history and signatures.
function stripQuoted(text) {
  const cut = text.search(/^(On .{5,200}wrote:|-{2,} ?Original Message|From: .+\n(Sent|Date): )/m);
  return (cut > 0 ? text.slice(0, cut) : text)
    .split('\n').filter(l => !l.startsWith('>')).join('\n')
    .replace(/\n-- \n[\s\S]*$/, '').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

// Full Gmail thread → messages with real addresses (used by the scan and by task chat).
function threadMessages(th, me) {
  return th.messages.map(m => {
    const from = header(m, 'From');
    const mine = emailOf(from) === me || (m.labelIds || []).includes('SENT');
    return {
      from: mine ? OWNER_NAME : nameOf(from), email: emailOf(from), me: mine,
      to: header(m, 'To'), cc: header(m, 'Cc'), subject: header(m, 'Subject'),
      at: new Date(Number(m.internalDate)).toISOString(),
      text: stripQuoted(bodyText(m.payload)) || m.snippet,
    };
  });
}

async function gmailThread(acc, threadId) {
  return threadMessages(await google.gmail(store, acc, `threads/${threadId}?format=full`), acc.meta.email.toLowerCase());
}

async function fetchGmail(acc, since) {
  const me = acc.meta.email.toLowerCase();
  const q = `after:${Math.floor(since / 1000)} -in:spam -in:trash -in:draft`; // includes SENT, so we see your replies
  let ids = [], pageToken;
  do {
    const r = await google.gmail(store, acc, `messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    ids.push(...(r.messages || []));
    pageToken = r.nextPageToken;
  } while (pageToken && ids.length < 300);

  const hdrs = ['From', 'To', 'Subject', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'].map(h => `metadataHeaders=${h}`).join('&');
  const metas = (await pool(ids, 10, m => google.gmail(store, acc, `messages/${m.id}?format=metadata&${hdrs}`))).filter(m => m && !m.error);

  // Group by thread; classify each thread by its inbound messages.
  const threads = new Map();
  for (const m of metas) {
    const from = header(m, 'From');
    const mine = (m.labelIds || []).includes('SENT') || emailOf(from) === me;
    const t = threads.get(m.threadId) || { inbound: [], mine: 0 };
    if (mine) t.mine++; else t.inbound.push({ m, from });
    threads.set(m.threadId, t);
  }

  const convs = [];
  for (const [threadId, t] of threads) {
    if (!t.inbound.length) continue; // only your own sent mail
    const last = t.inbound[t.inbound.length - 1];
    const labels = last.m.labelIds || [];
    const conv = {
      key: `g:${acc.id}:${threadId}`, source: 'gmail', accountId: acc.id, accountLabel: acc.label,
      where: acc.label, with: nameOf(last.from), withId: emailOf(last.from), subject: header(last.m, 'Subject'),
      link: `https://mail.google.com/mail/?authuser=${encodeURIComponent(acc.meta.email)}#all/${threadId}`,
      unsubscribe: rules.unsubscribeLink(header(last.m, 'List-Unsubscribe')),
      flags: {
        labels,
        unsubscribe: !!header(last.m, 'List-Unsubscribe'),
        bulk: /bulk|list/i.test(header(last.m, 'Precedence')) || /auto-/i.test(header(last.m, 'Auto-Submitted')) || !!header(last.m, 'List-Id'),
        noreply: /no-?reply|notifications?@|alerts?@|mailer/i.test(last.from),
        directToMe: header(last.m, 'To').toLowerCase().includes(me),
      },
      messages: t.inbound.map(x => ({ from: nameOf(x.from), me: false, at: new Date(Number(x.m.internalDate)).toISOString(), text: x.m.snippet })),
    };
    convs.push(conv);
  }

  // Full thread (with your replies, quotes stripped) only for threads that aren't obvious noise.
  await pool(convs.filter(c => !rules.isGmailNoise(c)), 6, async c => {
    const th = await google.gmail(store, acc, `threads/${c.key.split(':')[2]}?format=full`);
    c.messages = threadMessages(th, me).slice(-MAX_MSGS_PER_CONV);
  });
  return convs;
}

// ---- Slack -------------------------------------------------------------

// Slack throttles conversations.history/replies to ~1 call/min for non-Marketplace apps,
// so we read everything through search.messages instead: one call returns up to 100
// messages across all channels, DMs and threads (including your own replies).
const CONTEXT_HOURS = 12; // extra history before the window so the AI sees how a conversation started

async function fetchSlack(acc, since) {
  const { access_token: token } = store.getTokens(acc);
  const myId = acc.meta.userId;
  const sinceTs = since / 1000;
  const contextTs = sinceTs - CONTEXT_HOURS * 3600;
  const team = acc.meta.team.id;

  const users = new Map(), emails = new Map(), bots = new Set();
  let cursor;
  do {
    const r = await slack.api(token, 'users.list', { limit: 1000, ...(cursor && { cursor }) });
    r.members.forEach(u => {
      users.set(u.id, u.real_name || u.name);
      if (u.profile?.email) emails.set(u.id, u.profile.email);
      if (u.is_bot) bots.add(u.id);
    });
    cursor = r.response_metadata?.next_cursor;
  } while (cursor);

  // "after:" is day-granular and exclusive, so ask from the day before and filter by ts.
  const day = new Date((contextTs - 86400) * 1000).toISOString().slice(0, 10);
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const r = await slack.api(token, 'search.messages', { query: `after:${day}`, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
    const ms = r.messages.matches || [];
    matches.push(...ms);
    if (!ms.length || page >= (r.messages.paging?.pages || 1) || Number(ms[ms.length - 1].ts) < contextTs) break;
  }

  const clean = t => (t || '').replace(/<@(\w+)>/g, (_, id) => `@${users.get(id) || id}`).replace(/<([^|>]+)\|([^>]+)>/g, '$2').slice(0, 800);
  const msgs = matches.filter(m => Number(m.ts) >= contextTs).map(m => {
    const ch = m.channel || {};
    const threadTs = m.permalink && new URL(m.permalink).searchParams.get('thread_ts');
    return {
      // A thread's first message has thread_ts = its own ts, so parent and replies group together.
      ch, ts: m.ts, threadTs: threadTs || null,
      from: m.user === myId ? OWNER_NAME : users.get(m.user) || m.username || 'bot',
      email: emails.get(m.user), me: m.user === myId, bot: !!(m.bot_id || bots.has(m.user) || !m.user),
      at: new Date(Number(m.ts) * 1000).toISOString(),
      mentionsMe: (m.text || '').includes(`<@${myId}>`), text: clean(m.text),
    };
  }).sort((x, y) => Number(x.ts) - Number(y.ts));

  // Group into conversations: a DM, a thread, or a single channel message (with its neighbours).
  const groups = new Map();
  for (const m of msgs) {
    const dm = m.ch.is_im || m.ch.is_mpim;
    const key = m.threadTs ? `${m.ch.id}:${m.threadTs}` : dm ? m.ch.id : `${m.ch.id}:${m.ts}`;
    if (!groups.has(key)) groups.set(key, { key, ch: m.ch, dm, thread: !!m.threadTs, rootTs: m.threadTs || m.ts, messages: [] });
    const g = groups.get(key);
    g.messages.push(m);
    if (m.threadTs) g.thread = true; // parent message and its replies share the key `${channel}:${threadTs}`
  }
  const convs = [];
  let chatter = 0;
  const byChannel = msgs.reduce((acc, m) => ((acc[m.ch.id] ||= []).push(m), acc), {});
  for (const g of groups.values()) {
    if (!g.messages.some(m => Number(m.ts) >= sinceTs)) continue; // nothing new in the window
    const involved = g.dm || g.messages.some(m => m.me || m.mentionsMe || rules.NAME.test(m.text));
    if (!involved) { chatter++; continue; }
    let messages = g.messages;
    if (!g.dm && !g.thread) {
      // Plain channel message that mentions you: add a few surrounding messages for context.
      const all = byChannel[g.ch.id];
      const i = all.indexOf(g.messages[0]);
      messages = all.slice(Math.max(0, i - 4), i + 5);
    }
    const others = messages.filter(m => !m.me);
    const where = g.ch.is_im ? `DM · ${users.get(g.ch.user) || users.get(g.ch.name) || others[0]?.from || 'someone'}`
      : g.ch.is_mpim ? 'group DM' : `#${g.ch.name}`;
    // Where a reply should go: the thread itself, or a new thread under the last message from someone else.
    const lastIn = [...g.messages].reverse().find(m => !m.me) || g.messages[g.messages.length - 1];
    const replyTo = { channel: g.ch.id, thread_ts: g.thread ? g.rootTs : lastIn.ts };
    convs.push({
      key: `s:${acc.id}:${g.key}`, source: 'slack', accountId: acc.id, accountLabel: acc.label, replyTo,
      where: g.thread ? `${where} (thread)` : where,
      with: others[others.length - 1]?.from || 'someone', withId: others[others.length - 1]?.from,
      link: `https://slack.com/app_redirect?team=${team}&channel=${g.ch.id}&message_ts=${messages[messages.length - 1].ts}`,
      messages: messages.slice(-MAX_MSGS_PER_CONV),
      flags: {
        dm: !!g.ch.is_im, groupDm: !!g.ch.is_mpim, thread: g.thread,
        mention: messages.some(m => m.mentionsMe),
        bot: others.length > 0 && others.every(m => m.bot),
      },
    });
  }
  return { convs, chatter };
}

// ---- Pipeline ----------------------------------------------------------

const RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

async function run({ hours, only }) {
  hours = Math.min(Math.max(Number(hours) || MAX_HOURS, 0.25), MAX_HOURS);
  const since = Date.now() - hours * 3600e3;
  const accounts = store.db.accounts.filter(a => !only || a.provider === only);
  if (!accounts.length) return { hours, error: 'No accounts connected yet. Use "+ Add Gmail" / "+ Add Slack" above.' };

  const per = await pool(accounts, 3, async acc => {
    try {
      if (acc.provider === 'gmail') return { acc, convs: await fetchGmail(acc, since), chatter: 0 };
      return { acc, ...(await fetchSlack(acc, since)) };
    } catch (e) {
      return { acc, convs: [], chatter: 0, error: e.message };
    }
  });

  const convs = per.flatMap(p => p.convs);
  const tasksByConv = new Map(store.db.tasks.map(t => [t.convKey, t])); // latest task per conversation

  // 1) Non-AI filter.
  const skipped = { chatter: per.reduce((n, p) => n + (p.chatter || 0), 0) };
  const skippedList = [];
  const forAI = [];
  for (const c of convs) {
    const reason = rules.skipReason(c, tasksByConv.get(c.key), store.db.mutes);
    if (reason) {
      skipped[reason] = (skipped[reason] || 0) + 1;
      skippedList.push({ reason, with: c.with, where: c.where, subject: c.subject, link: c.link, unsubscribe: c.unsubscribe });
    } else forAI.push(c);
  }

  // 2) AI decides on what's left, with open/previous tasks and your past decisions as context.
  const verdicts = await ai.triage(forAI, tasksByConv, store.db.feedback.slice(-40));
  const now = new Date().toISOString();
  const result = { created: [], updated: [], closed: [], fyi: [] };
  const patches = []; // [taskId, fields] applied after re-reading tasks, so clicks made during the scan aren't lost

  for (const c of forAI) {
    const v = verdicts.get(c.key);
    if (!v) continue;
    const existing = tasksByConv.get(c.key);
    const open = existing && existing.status === 'open' ? existing : null;
    const lastIn = [...c.messages].reverse().find(m => !m.me);

    if (open && v.resolved) {
      patches.push([open.id, { status: 'done', done: true, doneAt: now, autoNote: v.why || 'handled in the conversation' }]);
      result.closed.push(open);
      continue;
    }
    if (v.needsMe && v.task) {
      const fields = {
        type: v.type, title: v.task.title, due: v.task.due || null, priority: v.priority, summary: v.summary, why: v.why,
        from: c.with, where: c.where, source: c.source, link: c.link, lastActivity: lastIn?.at, updatedAt: now,
        ...(c.replyTo && { replyTo: c.replyTo }),
        // Snapshot of the conversation so you can chat about the task later.
        context: { subject: c.subject, messages: c.messages.map(({ from, email, to, cc, at, text }) => ({ from, email, to, cc, at, text: (text || '').slice(0, 1500) })) },
      };
      if (open) { patches.push([open.id, fields]); result.updated.push(open); }
      else result.created.push({ id: crypto.randomUUID(), convKey: c.key, status: 'open', done: false, comments: [], createdAt: now, ...fields });
    } else if (v.priority !== 'P3') {
      result.fyi.push({ with: c.with, where: c.where, summary: v.summary, link: c.link });
    } else {
      skipped.ai_ignored = (skipped.ai_ignored || 0) + 1;
    }
  }
  await store.load(['tasks', 'items']);
  for (const [id, fields] of patches) {
    const t = store.db.tasks.find(x => x.id === id);
    if (t && t.status === 'open') Object.assign(t, fields);
  }
  store.db.tasks.push(...result.created);

  // Keep a digest of what was read (for follow-up questions in chat), trimmed to 24h.
  const cutoff = Date.now() - MAX_HOURS * 3600e3;
  const digest = new Map(store.db.items.filter(i => Date.parse(i.at) > cutoff).map(i => [i.key, i]));
  for (const c of convs) {
    const v = verdicts.get(c.key);
    digest.set(c.key, {
      key: c.key, with: c.with, where: c.where, subject: c.subject, summary: v?.summary, needsMe: v?.needsMe,
      at: c.messages[c.messages.length - 1]?.at || new Date().toISOString(),
      messages: c.messages.slice(-6).map(m => `${m.me ? OWNER_NAME : m.from}: ${(m.text || '').slice(0, 200)}`),
    });
  }
  store.db.items = [...digest.values()];
  await store.save(['tasks', 'items']);

  return {
    hours,
    accounts: per.map(p => ({ label: p.acc.label, convs: p.convs.length, error: p.error })),
    totalConvs: convs.length, aiLooked: forAI.length, skipped, skippedList,
    created: result.created, updated: result.updated, closed: result.closed, fyi: result.fyi,
  };
}

// One scan at a time so overlapping requests can't create duplicate tasks.
let queue = Promise.resolve();
const runQueued = opts => (queue = queue.then(() => run(opts), () => run(opts)));

module.exports = { run: runQueued, gmailThread, MAX_HOURS };
