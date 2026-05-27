const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL || "codePerks <onboarding@resend.dev>";

function buildFromAddress(fromName = "") {
  const cleanName = String(fromName || "").replace(/[<>]/g, "").trim();
  const match = String(DEFAULT_FROM).match(/<([^>]+)>/);
  const email = match ? match[1] : String(DEFAULT_FROM).trim();

  if (!cleanName) return DEFAULT_FROM;
  return `${cleanName} <${email}>`;
}

async function sendEmail({ to, subject, html, text, fromName }) {
  if (!resend) throw new Error("RESEND_API_KEY not set");

  return resend.emails.send({
    from: buildFromAddress(fromName),
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text,
  });
}

module.exports = { sendEmail };
