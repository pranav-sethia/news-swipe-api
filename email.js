const { Resend } = require('resend');

const enabled = !!process.env.RESEND_API_KEY;
const resend = enabled ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESEND_FROM_EMAIL || 'HackerSwipe <onboarding@resend.dev>';

if (!enabled) {
  console.info('Email sending disabled: set RESEND_API_KEY to enable.');
}

async function sendPasswordResetEmail(to, resetUrl) {
  if (!enabled) {
    console.info(`Email disabled, would have sent password reset link to ${to}: ${resetUrl}`);
    return;
  }
  await resend.emails.send({
    from: FROM,
    to,
    subject: 'Reset your HackerSwipe password',
    html: `
      <div style="font-family: monospace; background: #080808; color: #e8e8e8; padding: 32px;">
        <p style="color: #ff6600; font-weight: bold; letter-spacing: 1px;">HACKERSWIPE</p>
        <p>Someone asked to reset the password on this account. If that was you, click below:</p>
        <p><a href="${resetUrl}" style="color: #ff6600;">Reset your password</a></p>
        <p style="color: #888; font-size: 13px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendPasswordResetEmail, enabled };
