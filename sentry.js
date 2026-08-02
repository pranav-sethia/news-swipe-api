const Sentry = require('@sentry/node');

const enabled = !!process.env.SENTRY_DSN;

if (enabled) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
  });
} else {
  console.info('Error tracking disabled: set SENTRY_DSN to enable.');
}

module.exports = { Sentry, enabled };
