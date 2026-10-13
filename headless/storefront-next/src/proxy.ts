import { NextResponse, type NextRequest } from 'next/server';

// Runs before every page, route handler, and server action. It sets the security headers,
// gives server-rendered scripts a per-request nonce, and makes sure the browser has a
// session cookie. The session row itself is created by the server on first use.

import { SESSION_MINTED_HEADER } from './shared/session-header.ts';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'storefront_session';
const SECURE = (process.env.APP_ORIGIN ?? '').startsWith('https:');
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function challengeOrigin(): string {
  return process.env.FLINT_API_BASE_URL === 'https://api.withflintpay.com' ? 'https://checkout.withflintpay.com' : 'https://checkout.staging.withflintpay.com';
}

function contentSecurityPolicy(nonce: string): string {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${dev ? " 'unsafe-eval'" : ''}`,
    `frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com ${challengeOrigin()}`,
    "connect-src 'self' https://api.stripe.com https://*.stripe.com",
    "img-src 'self' data: https://*.stripe.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64url');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.delete(SESSION_MINTED_HEADER);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);

  // Only reads mint a cookie: a change request without a session is refused by the server.
  const current = request.cookies.get(COOKIE_NAME)?.value;
  const reading = request.method === 'GET' || request.method === 'HEAD';
  let minted: string | undefined;
  if (reading && (!current || !TOKEN_SHAPE.test(current))) {
    minted = token();
    headers.set(SESSION_MINTED_HEADER, minted);
    const others = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part && !part.startsWith(`${COOKIE_NAME}=`));
    headers.set('cookie', [...others, `${COOKIE_NAME}=${minted}`].join('; '));
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Permissions-Policy', 'payment=(self "https://js.stripe.com")');
  response.headers.set('Cache-Control', 'no-store');
  // A read refreshes the cookie's lifetime. Writes leave it alone so sign-in and sign-out can replace it.
  const value = minted ?? (reading ? current : undefined);
  if (value) response.cookies.set(COOKIE_NAME, value, { httpOnly: true, secure: SECURE, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 });
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|images/|favicon.ico|healthz|webhooks/|session/renew).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
