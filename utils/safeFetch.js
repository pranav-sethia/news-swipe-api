const dns = require('dns').promises;
const net = require('net');

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

// Blocks loopback, RFC1918, link-local (which includes the 169.254.169.254
// cloud metadata endpoint), and IPv6 equivalents.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.split(':').pop();
      if (net.isIPv4(v4)) return isPrivateIp(v4);
    }
    return false;
  }
  return true; // unrecognized format - reject conservatively
}

// Ingestion pulls og:image/article URLs straight from external, attacker-
// influenceable HN submissions. Without this, a crafted URL (or a redirect
// hidden behind an initially-safe-looking one) could point at an internal
// service or the cloud metadata endpoint, and the response could end up
// stored in articles.description or image_url - visible to every user.
async function isSafeUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    if (addresses.length === 0) return false;
    return addresses.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}

// Reads a fetch Response body with a hard byte cap, aborting early instead
// of trusting a (possibly absent or lied-about) Content-Length header - a
// slow-drip or huge body would otherwise buffer fully into memory first.
async function readWithSizeLimit(res, maxBytes) {
  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error('Response too large');
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Response exceeded size limit while streaming');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// fetch() with SSRF protection: checks the resolved IP before every hop,
// following redirects manually so a safe-looking initial URL can't redirect
// to an internal address unchecked.
async function safeFetch(urlString, options = {}) {
  let currentUrl = urlString;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!(await isSafeUrl(currentUrl))) {
      throw new Error(`Refusing to fetch unsafe URL: ${currentUrl}`);
    }
    const res = await fetch(currentUrl, { ...options, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirect with no Location header');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

module.exports = { isSafeUrl, safeFetch, readWithSizeLimit, DEFAULT_MAX_BYTES };
