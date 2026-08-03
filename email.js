const { Resend } = require('resend');

const enabled = !!process.env.RESEND_API_KEY;
const resend = enabled ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESEND_FROM_EMAIL || 'HackerSwipe <onboarding@resend.dev>';

if (!enabled) {
  console.info('Email sending disabled: set RESEND_API_KEY to enable.');
}

// The Resend SDK does not throw on API-level failures (bad recipient, sandbox
// domain restrictions, etc.) - it resolves with { data, error }. Not checking
// that meant a failed send looked identical to a successful one.
function logIfFailed(result, context) {
  if (result?.error) {
    console.error(`Failed to send email (${context}):`, result.error);
  }
}

async function sendPasswordResetEmail(to, resetUrl) {
  if (!enabled) {
    console.info(`Email disabled, would have sent password reset link to ${to}: ${resetUrl}`);
    return;
  }
  const result = await resend.emails.send({
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
  logIfFailed(result, 'password reset');
}

async function sendGoogleAccountNoticeEmail(to) {
  if (!enabled) {
    console.info(`Email disabled, would have told ${to} their account uses Google Sign-In.`);
    return;
  }
  const result = await resend.emails.send({
    from: FROM,
    to,
    subject: 'About your HackerSwipe password reset request',
    html: `
      <div style="font-family: monospace; background: #080808; color: #e8e8e8; padding: 32px;">
        <p style="color: #ff6600; font-weight: bold; letter-spacing: 1px;">HACKERSWIPE</p>
        <p>Someone requested a password reset for this email, but this account was created with Google Sign-In and doesn't have a password.</p>
        <p>Just sign in with Google instead. If this wasn't you, no action is needed.</p>
      </div>
    `,
  });
  logIfFailed(result, 'google account notice');
}

module.exports = { sendPasswordResetEmail, sendGoogleAccountNoticeEmail, enabled };
