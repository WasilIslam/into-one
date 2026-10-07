// Who the inbox belongs to. Used in AI prompts and to spot your name in messages.
const OWNER_NAME = process.env.OWNER_NAME || 'Wasil';
const OWNER_ROLE = process.env.OWNER_ROLE || 'an overloaded freelance developer / agency owner';

module.exports = { OWNER_NAME, OWNER_ROLE };
