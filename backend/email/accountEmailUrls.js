function actionUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid account email action URL');
  }
  return url.href;
}

function platformUrl(path) {
  const base = new URL(process.env.EMAIL_BASE_URL || process.env.APP_BASE_URL || 'https://www.lets-paraconnect.com');
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Invalid account email origin');
  }
  return new URL(path, base.origin).href;
}

module.exports = { actionUrl, platformUrl };
