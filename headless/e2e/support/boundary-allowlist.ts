// Payment relays and exact family-audited email relays only. No Flint commerce pages.
// Email paths are defined in email-links.ts and require this run's audited URL.
// Every relay must redirect to the required merchant destination within ten seconds.
// PDFs are proxied by the applications, so no Flint document host is permitted.
export const relayOrigin = 'https://api.staging.withflintpay.com';
export const relayPath = /^\/payment-returns\/[A-Za-z0-9_-]+$/;
export const documentAllowlist: readonly never[] = [];
export const stripeOrigins = new Set(['https://js.stripe.com', 'https://api.stripe.com', 'https://hooks.stripe.com', 'https://m.stripe.network']);
