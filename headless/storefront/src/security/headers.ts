import type {Config} from '../config.ts';
export function securityHeaders(config:Pick<Config,'giftChallengeOrigin'>):Record<string,string>{return {
  'Content-Security-Policy': `default-src 'self'; script-src 'self' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com ${config.giftChallengeOrigin}; connect-src 'self' https://api.stripe.com https://*.stripe.com; img-src 'self' data: https://*.stripe.com; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  'Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff',
  'Permissions-Policy':'payment=(self "https://js.stripe.com")','Cache-Control':'no-store'
};}
