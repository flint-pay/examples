// @ts-check
// Reads a gift card recipient link without opening it.
//
// Accepted: https on any host (a store's checkout can use its own hostname), or http only for
// localhost and 127.0.0.1. The path is exactly /gift-cards/{grant_id} with at most one trailing
// slash, and grant_id looks like gcg_ followed by 26 characters of Crockford base 32. The token is
// the `token` parameter of the fragment. The query and any other fragment keys are ignored and
// never sent.

export const GRANT_PATTERN = /^gcg_[0-9A-HJKMNP-TV-Z]{26}$/;
export const MAX_TOKEN_LENGTH = 4096;

/**
 * @param {string} value
 * @returns {{ grantId: string, token: string } | null}
 */
export function parseGiftCardLink(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  if (url.username || url.password) return null;
  const match = /^\/gift-cards\/([^/]+)\/?$/.exec(url.pathname);
  const grantId = match?.[1];
  if (!grantId || !GRANT_PATTERN.test(grantId)) return null;
  const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  return { grantId, token };
}
