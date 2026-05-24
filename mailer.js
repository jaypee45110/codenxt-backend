const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || "codePerks <onboarding@resend.dev>";

async function sendEmail({ to, subject, html, text }) {
  if (!resend) throw new Error("RESEND_API_KEY not set");

  return resend.emails.send({
    from: DEFAULT_FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  });
}

module.exports = { sendEmail };
