const nodemailer = require('nodemailer');

let transport;

function getTransport() {
  if (transport !== undefined) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    transport = null;
    return transport;
  }
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  return transport;
}

async function sendEmail({ to, subject, text, html, attachments = [] }) {
  const mailer = getTransport();
  if (!mailer) return;
  const fromAddress = process.env.SMTP_FROM || process.env.SUPPORT_EMAIL || 'no-reply@soulmed.ai';
  await mailer.sendMail({
    from: fromAddress,
    to,
    subject,
    text,
    html,
    attachments,
  });
}

module.exports = { sendEmail };
