// Sign-in link emails via Resend.
async function sendSignInLink(to, link) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `into-one <${process.env.RESEND_FROM}>`,
      to: [to],
      subject: 'Your into-one sign-in link',
      text: `Sign in to into-one:\n\n${link}\n\nThis link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      html: `<div style="font-family:Verdana,Arial,sans-serif;font-size:15px">
        <p>Sign in to <b>into-one</b>:</p>
        <p><a href="${link}" style="font-size:17px;font-weight:bold">&raquo; Sign in</a></p>
        <p style="color:#666;font-size:12px">This link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.</p></div>`,
    }),
  });
  if (!r.ok) throw new Error(`Resend: ${(await r.json().catch(() => ({}))).message || r.status}`);
}

module.exports = { sendSignInLink };
