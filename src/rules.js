// Non-AI filters. A conversation that fails any of these never reaches the AI.
const NOISE_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
const { OWNER_NAME } = require('./owner');
const NAME = new RegExp(`\\b${OWNER_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
// Short replies that close a loop rather than open one.
const ACK = /^\s*(ok(ay)?|k|kk|thanks?( you)?|thx|ty|great|perfect|cool|nice|done|got it|sure|noted|sounds good|alright|np|no problem|👍|🙏|✅|👌|❤️|🙌|\s)+[.!]*\s*$/i;
// When your last message is a promise, the conversation still matters.
const PROMISE = /\b(i'?ll|i will|will (send|do|check|share|update|fix|look)|let me|tomorrow|by (eod|tonight|monday|tuesday|wednesday|thursday|friday)|later today|get back to you)\b/i;

function unsubscribeLink(header) {
  if (!header) return null;
  const links = [...header.matchAll(/<([^>]+)>/g)].map(m => m[1]);
  return links.find(l => l.startsWith('http')) || links[0] || null;
}

function isGmailNoise(c) {
  const f = c.flags;
  return NOISE_CATEGORIES.some(x => f.labels.includes(x)) || (f.unsubscribe && !f.directToMe) || (f.bulk && f.unsubscribe);
}

// Returns a reason string if the conversation can be skipped without AI, else null.
function skipReason(c, task, mutes = []) {
  const openTask = task && task.status === 'open';
  if (mutes.some(m => m.id && (m.id === c.withId || m.id === c.with))) return 'muted';
  if (c.source === 'gmail' && isGmailNoise(c)) return 'newsletter';
  if (c.flags.bot && !c.flags.mention) return openTask ? null : 'bot';

  const last = c.messages[c.messages.length - 1];
  if (!last) return 'empty';
  // An open task always goes to the AI so it can be updated or auto-closed.
  if (openTask) return null;
  if (last.me && !PROMISE.test(last.text)) return 'you_replied_last';
  const theirs = c.messages.slice(c.messages.findLastIndex(m => m.me) + 1);
  if (theirs.length && theirs.every(m => ACK.test(m.text))) return 'just_ack';
  return null;
}

module.exports = { unsubscribeLink, isGmailNoise, skipReason, NAME };
