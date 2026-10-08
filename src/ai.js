// OpenAI calls. Small model, batched, JSON out.
const { OWNER_NAME, OWNER_ROLE } = require('./owner');
const MODEL = process.env.AI_MODEL || 'gpt-5.4-mini';

async function complete(messages, json = false) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, ...(json && { response_format: { type: 'json_object' } }) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI: ${j.error?.message || r.status}`);
  return j.choices[0].message.content;
}

const TRIAGE_PROMPT = `You are the chief of staff for ${OWNER_NAME}, ${OWNER_ROLE}.
You get whole CONVERSATIONS (Gmail threads, Slack DMs/threads) with his own messages marked "${OWNER_NAME}".
Your job: protect his attention. Surface a conversation ONLY if ${OWNER_NAME} is the blocker right now:
 - someone asked him something / is waiting on him and he has NOT answered or done it yet
 - he promised something ("I'll send it tomorrow") and hasn't delivered
 - money, a deadline, a client problem or a security/billing risk needs his action
Read the full conversation in order. If the latest messages show it's already handled (he replied, gave access,
did the thing, the topic moved on, the other person just acknowledged) → needsMe=false.
Automated mail (receipts, bank alerts, OTPs, PINs, status notifications, digests, ToS updates) → needsMe=false,
unless something FAILED, is overdue or needs a decision.
If "openTask" is given: set resolved=true when the conversation shows it's done or no longer relevant.
If "previousTask" is given it was already closed by ${OWNER_NAME} — only create a new task for a NEW ask after it.
"pastDecisions" shows what ${OWNER_NAME} marked done or ignored (with his reason). Learn from it: don't surface things
like the ones he ignored as "not important"/"noise"; be extra careful about "already handled" cases.
Prefer fewer, sharper tasks. When unsure, needsMe=false with priority P2 (shown as FYI).

For EACH conversation return:
{"key": same key,
 "needsMe": true|false,
 "resolved": true|false,
 "type": "reply"|"do"|"fix"|"pay"|"review"|"meet"|"promise"|"fyi",
 "priority": "P0" (today: blocked client, money/security risk) | "P1" (this week) | "P2" (FYI) | "P3" (ignore),
 "summary": "<= 14 words: what is going on now, in plain English",
 "why": "<= 10 words: why this needs him or why not",
 "task": null or {"title": "<= 10 words, starts with a verb, names the person", "due": "today"|"tomorrow"|"Fri"|null}}
Return JSON {"items":[...]}.`;

function convForAI(c, task, now) {
  const lastMine = c.messages.findLastIndex(m => m.me);
  const firstWaiting = c.messages[lastMine + 1];
  return {
    key: c.key, source: c.source, where: c.where, with: c.with, subject: c.subject || undefined,
    flags: Object.fromEntries(Object.entries(c.flags).filter(([, v]) => v === true)),
    waitingMinutes: firstWaiting && !c.messages[c.messages.length - 1].me ? Math.round((now - Date.parse(firstWaiting.at)) / 60000) : 0,
    messages: c.messages.map(m => ({ from: m.me ? OWNER_NAME : m.from, at: m.at.slice(0, 16), text: (m.text || '').slice(0, 700) })),
    ...(task && task.status === 'open' && { openTask: { title: task.title, comments: task.comments.map(x => x.text) } }),
    ...(task && task.status !== 'open' && { previousTask: { title: task.title, status: task.status, closedAt: task.doneAt } }),
  };
}

// Returns Map(key → verdict).
async function triage(convs, tasksByConv, feedback) {
  const out = new Map();
  const now = Date.now();
  const past = feedback.map(f => ({ action: f.action, reason: f.reason, title: f.title, from: f.from, type: f.type }));
  const batches = [];
  for (let i = 0; i < convs.length; i += 12) batches.push(convs.slice(i, i + 12));
  await Promise.all(batches.map(async batch => {
    const res = JSON.parse(await complete([
      { role: 'system', content: TRIAGE_PROMPT },
      { role: 'user', content: JSON.stringify({ now: new Date(now).toISOString(), pastDecisions: past, conversations: batch.map(c => convForAI(c, tasksByConv.get(c.key), now)) }) },
    ], true));
    (res.items || []).forEach(v => out.set(v.key, v));
  }));
  return out;
}

// Things either chat may do to tasks. The server validates and applies them.
const ACTIONS_DOC = `"actions" is a list of changes to make to tasks, ONLY when ${OWNER_NAME} asks for them (or clearly states it's done/handled):
 {"op":"done"}                                   mark the task done
 {"op":"ignore","reason":"..."}                  hide the task (not important / already handled)
 {"op":"reopen"}                                 reopen a done/hidden task
 {"op":"update","title":"...","due":"Fri","priority":"P0|P1|P2|P3","type":"reply|do|fix|pay|review|meet|promise"}  change any of these fields
 {"op":"note","text":"..."}                      add a note to the task
 {"op":"create","title":"...","due":"...","priority":"P1"}  add a NEW task (e.g. a follow-up)
Never invent actions he didn't ask for. Answering a question = no actions.`;

async function answer(question, context) {
  const out = JSON.parse(await complete([
    { role: 'system', content: `You are into-one, ${OWNER_NAME}'s inbox assistant. Answer briefly in plain text (no markdown), using only the conversations and tasks given. If the info is not there, say so and suggest reading more (e.g. "read last 6 hours").
You can also manage his task list. Tasks have short ids like "t3".
${ACTIONS_DOC}
Every action except "create" needs "task":"<id>". In "reply", refer to tasks by their title, never by id. Return JSON {"reply":"...","actions":[...]}. "reply" confirms what you did in one short line when you take actions.` },
    { role: 'user', content: `CONTEXT:\n${JSON.stringify(context)}\n\nMESSAGE: ${question}` },
  ], true));
  return { reply: String(out.reply || ''), actions: Array.isArray(out.actions) ? out.actions : [] };
}

// Chat about one task, grounded in its source conversation. Returns { intent, reply, draft|null, actions[] }.
async function taskAnswer(task, source, history, question) {
  const channel = task.source === 'slack' ? 'Slack' : 'email';
  const out = JSON.parse(await complete([
    { role: 'system', content: `You help ${OWNER_NAME} with ONE task from his inbox. You get the task and the full source conversation (with sender/recipient email addresses and dates).
Decide what he wants:
 - "answer": a question about the task/conversation. Answer directly and briefly in plain text (no markdown) in "reply". Quote exact emails, names, dates and numbers. If it isn't in the source, say so. "draft" MUST be null.
 - "draft": he asks you to write/reply/send/tell/ask someone something, or gives feedback on a previous draft ("shorter", "mention Friday"). Put ONLY the message to send in "draft" (ready to send as a ${channel} reply in this same conversation, in his voice: short, friendly, professional, no subject line, ${channel === 'email' ? `sign off as "${OWNER_NAME}"` : 'no sign-off'}). "reply" is one short line like "Here's a draft:".
 - "action": he wants to change the task itself (done, hide, due date, priority, rename, note, follow-up task). Put the changes in "actions" and confirm in one short line in "reply". "draft" null.
${ACTIONS_DOC}
In this chat actions apply to THIS task (no "task" field needed), except "create".
Return JSON {"intent":"answer|draft|action","reply":"...","draft":null or "...","actions":[]}.` },
    { role: 'user', content: `TASK:\n${JSON.stringify({ title: task.title, from: task.from, where: task.where, due: task.due, priority: task.priority, status: task.status, summary: task.summary, notes: (task.comments || []).map(c => c.text) })}\n\nSOURCE CONVERSATION:\n${JSON.stringify(source)}` },
    ...history.slice(-12).map(m => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.draft ? `${m.text}\n[draft${m.draft.sentAt ? ' — already sent' : ''}]\n${m.draft.text}` : m.text })),
    { role: 'user', content: question },
  ], true));
  return {
    intent: out.intent || (out.draft ? 'draft' : 'answer'),
    reply: String(out.reply || ''),
    draft: out.intent === 'draft' && out.draft ? String(out.draft) : null,
    actions: Array.isArray(out.actions) ? out.actions : [],
  };
}

module.exports = { triage, answer, taskAnswer, MODEL };
