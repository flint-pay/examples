// LOCAL STATE TEST SUPPORT for the gift card verification. Not Flint and not the account app.
//
// The real frame lives on Flint's checkout host. Tests serve a fake page for the same address
// (page.route), so message origins are genuine. Every token, proof, and session ID here is a
// made-up placeholder. The fake page behaves according to the last part of its address.

import { createHash } from 'node:crypto';

export const CHALLENGE_ORIGIN = 'https://checkout.staging.withflintpay.com';
export const FAKE_PROOF = 'proof_fake_0001';
const TAG_PREFIX = 'flint-examples.gift-challenge.v1\n';

export const sessionIdFor = (surface: string) => `cs_fake_${surface}`;

export function sessionTag(challengeId: string, checkoutSessionId: string): string {
  return createHash('sha256').update(`${TAG_PREFIX}${challengeId}\n${checkoutSessionId}`).digest('base64url');
}

export type Retry = 'applied' | 'rejected' | 'expired' | 'origin' | 'unavailable' | 'unknown' | 'stale' | 'refused' | 'proxy502' | 'proxy503';
export interface ChallengeCode {
  page: string;
  retry?: Retry;
  url?: string;
  expires?: number;
  apply?: 'origin' | 'unavailable';
}

/** Gift card codes that start a check. The code picks what the fake frame and the fake app do next. */
export const challengeCodes: Record<string, ChallengeCode> = {
  CHALLENGE: { page: 'completed' },
  CHALLENGEDOUBLE: { page: 'double' },
  CHALLENGEFAIL: { page: 'failed' },
  CHALLENGEGONE: { page: 'unavailable' },
  CHALLENGESILENT: { page: 'silent' },
  CHALLENGESHORT: { page: 'silent', expires: 120 },
  CHALLENGESPOOF: { page: 'spoof' },
  CHALLENGEWRONG: { page: 'wrongsession' },
  CHALLENGEREJECT: { page: 'completed', retry: 'rejected' },
  CHALLENGEEXPIRED: { page: 'completed', retry: 'expired' },
  CHALLENGEORIGIN: { page: 'completed', retry: 'origin' },
  CHALLENGEUNAVAIL: { page: 'completed', retry: 'unavailable' },
  CHALLENGEUNKNOWN: { page: 'completed', retry: 'unknown' },
  CHALLENGESTALE: { page: 'completed', retry: 'stale' },
  CHALLENGEREFUSED: { page: 'completed', retry: 'refused' },
  // A proxy answers the proof request with its own page. The app may or may not have processed it.
  PROXYPROOF502: { page: 'completed', retry: 'proxy502' },
  PROXYPROOF503: { page: 'completed', retry: 'proxy503' },
  UNTRUSTEDHTTP: { page: 'completed', url: 'http://checkout.staging.withflintpay.com/gift-card-challenge/gccf_fake.completed' },
  UNTRUSTEDHOST: { page: 'completed', url: 'https://evil.example.test/gift-card-challenge/gccf_fake.completed' },
  UNTRUSTEDPATH: { page: 'completed', url: `${CHALLENGE_ORIGIN}/gift-card-challenge/gccf_fake/completed` },
  UNTRUSTEDQUERY: { page: 'completed', url: `${CHALLENGE_ORIGIN}/gift-card-challenge/gccf_fake.completed?next=1` },
  ORIGINAPPLY: { page: 'completed', apply: 'origin' },
  NOCHECK: { page: 'completed', apply: 'unavailable' },
};

export function frameUrl(spec: ChallengeCode): string {
  return spec.url ?? `${CHALLENGE_ORIGIN}/gift-card-challenge/gccf_fake.${spec.page}`;
}

/**
 * The document the fake challenge host serves. It posts to its parent with the app origin as the
 * target, as Flint's page does. `scenario` is the last part of the frame address.
 */
export function challengePageHtml(scenario: string, sessionId: string, appOrigin: string): string {
  const completed = { type: 'flint.gift_card_challenge.completed', checkout_session_id: sessionId, proof: FAKE_PROOF, expires_at: '2026-10-08T12:15:00Z' };
  const messages: Record<string, unknown[]> = {
    completed: [completed],
    double: [completed, completed],
    failed: [{ type: 'flint.gift_card_challenge.failed', checkout_session_id: sessionId, reason: 'verification_failed' }],
    unavailable: [{ type: 'flint.gift_card_challenge.failed', checkout_session_id: sessionId, reason: 'unavailable' }],
    silent: [],
    wrongsession: [{ ...completed, checkout_session_id: 'cs_fake_someone_else' }],
    spoof: [
      { ...completed, checkout_session_id: 'cs_fake_someone_else' },
      { type: 'flint.gift_card_challenge.progress', checkout_session_id: sessionId },
      'flint.gift_card_challenge.completed',
      [completed],
      { ...completed, proof: 'has a space' },
      completed,
    ],
  };
  const list = JSON.stringify(messages[scenario] ?? []).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Fake verification</title><body style="margin:0;font:14px sans-serif"><p style="margin:0;padding:20px">Fake verification</p><script>
    const target = ${JSON.stringify(appOrigin)};
    for (const message of ${list}) parent.postMessage(message, target);
  </script></body>`;
}
