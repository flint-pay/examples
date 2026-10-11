import { paymentRelayOrigin, relayPath } from './boundary-allowlist.ts';
import { invariant } from './safe.ts';

export type Surface = 'url' | 'cookie' | 'storage' | 'dom' | 'body' | 'console' | 'child' | 'request';
export type ScanContext = { providerJob?: boolean; sensitiveInput?: boolean; submittedGift?: boolean; stripeTransport?: boolean;challengeProofSubmit?:boolean;paymentReturn?: boolean };
function decodedValues(value: string, rejectMalformed = false): string[] {
  const values = [value];
  for (let depth = 0; depth < 5; depth++) {
    try {
      const next = decodeURIComponent(values.at(-1)!);
      if (next === values.at(-1)) break;
      values.push(next);
    } catch { if (rejectMalformed) return []; break; }
  }
  if (rejectMalformed && values.at(-1)!.includes('%')) return [];
  return values;
}
function urlValues(value: string, url?: URL): string[] {
  const parts = [value];
  if (url) parts.push(url.username, url.password, url.pathname, url.hash, ...[...url.searchParams].flat());
  return parts.flatMap(part => decodedValues(part));
}
const transportShapes = [
  { path: /^\/v1\/elements\/sessions$/, secret: /^seti_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/ },
  { path: /^\/v1\/payment_intents\/(pi_[A-Za-z0-9]+)$/, secret: /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/, boundId: true },
];
export const stripeTransportPath = /^\/v1\/(?:elements\/sessions|payment_intents\/pi_[A-Za-z0-9]+)$/;
function elementsTransportRemainder(value: string, url: URL, context: ScanContext): URL | undefined {
  if (!context.stripeTransport || url.origin !== 'https://api.stripe.com' || url.username || url.password || value.includes('#')) return;
  const shape = transportShapes.map(candidate => ({ candidate, match: candidate.path.exec(url.pathname) })).find(entry => entry.match);
  if (!shape) return;
  const secrets = url.searchParams.getAll('client_secret'), keys = url.searchParams.getAll('key');
  if (secrets.length !== 1 || !shape.candidate.secret.test(secrets[0]) || keys.length !== 1 || !/^pk_test_[A-Za-z0-9]+$/.test(keys[0])) return;
  if (shape.candidate.boundId && !secrets[0].startsWith(`${shape.match![1]}_secret_`)) return;
  if ([...url.searchParams.keys()].some(key => key !== 'client_secret' && decodedValues(key).some(decoded => /^(?:email|password|code|client_secret|access_token|checkout_auth_token|secret|token|refresh_token|customer_session_secret)$/i.test(decoded)))) return;
  const remainder = new URL(url.href);
  remainder.searchParams.delete('client_secret');
  const parts = [remainder.href, remainder.pathname, ...[...remainder.searchParams].flat()];
  if (parts.some(part => decodedValues(part, true).length === 0)) return;
  return remainder;
}
// Stripe's redirect return: exactly three plain query names on the exact relay, with the secret bound to the intent.
export function paymentReturnRelayUrl(url: URL): boolean {
  if (url.origin !== paymentRelayOrigin || !relayPath.test(url.pathname) || url.username || url.password || url.href.includes('#') || !/^\?[A-Za-z0-9_=&]+$/.test(url.search)) return false;
  const entries = url.search.slice(1).split('&').map(part => part.split('='));
  if (entries.length !== 3 || entries.some(entry => entry.length !== 2 || !entry[1])) return false;
  const query = new Map(entries.map(([key, value]) => [key, value] as const));
  const intent = query.get('payment_intent'), secret = query.get('payment_intent_client_secret'), status = query.get('redirect_status');
  return query.size === 3 && !!intent && !!secret && !!status && /^pi_[A-Za-z0-9]{1,64}$/.test(intent) && /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]{1,128}$/.test(secret) && secret.startsWith(`${intent}_secret_`) && ['succeeded', 'pending', 'failed'].includes(status);
}
function paymentReturnRemainder(url: URL, context: ScanContext): URL | undefined {
  if (!context.paymentReturn || !paymentReturnRelayUrl(url)) return;
  const remainder = new URL(url.href);
  remainder.searchParams.delete('payment_intent_client_secret');
  return remainder;
}
export class CredentialScanner {
  violations: Set<string> = new Set();
  #surfaces = new Set<Surface>();
  surfaces(): Surface[] { return [...this.#surfaces].sort(); }
  private listeners = new Set<() => void>();
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  #secrets = new Set<string>();
  #giftSecrets = new Set<string>();
  constructor(secrets: string[] = []) { for (const secret of secrets) if (secret) this.#secrets.add(secret); }
  addCredential(secret: string): void { invariant(secret.length > 0, 'CREDENTIAL_EMPTY'); this.#secrets.add(secret); }
  addGift(secret: string): void { invariant(secret.length >= 6, 'GIFT_SECRET_INVALID'); this.#giftSecrets.add(secret); }
  scan(value: string, surface: Surface, context: ScanContext = {}): void {
    const count = this.violations.size;
    let url: URL | undefined;
    if (surface === 'url') { try { url = new URL(value); } catch { this.violations.add('INVALID_URL'); } }
    const values = surface === 'url' ? urlValues(value, url) : [value];
    if (values.some(v => /(flint_(?:test|live|cses|cref)_|ckat_|cklt_|whsec_)[A-Za-z0-9_-]+/.test(v) || [...this.#secrets].some(s => v.includes(s)))) this.violations.add(`CREDENTIAL_${surface.toUpperCase()}`);
    const proofs=values.flatMap(v => v.match(/gccp_[A-Za-z0-9_-]{20,}/g)??[]);
    if(proofs.length){
      if(surface==='request'&&context.challengeProofSubmit)for(const proof of proofs)this.#secrets.add(proof);
      else this.violations.add(`CHALLENGE_PROOF_${surface.toUpperCase()}`);
    }
    if ([...this.#giftSecrets].some(s => values.some(v => v.includes(s))) && !(surface === 'request' && context.submittedGift) && !(surface === 'dom' && context.sensitiveInput)) this.violations.add(`GIFT_AUTHORITY_${surface.toUpperCase()}`);
    const remainder = url && (elementsTransportRemainder(value, url, context) ?? paymentReturnRemainder(url, context));
    const providerValues = remainder ? urlValues(remainder.href, remainder) : values;
    if (providerValues.some(v => /[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+/.test(v)) && !(surface === 'body' && context.providerJob) && !(surface === 'request' && context.stripeTransport)) this.violations.add(`PROVIDER_SECRET_${surface.toUpperCase()}`);
    if (surface === 'body' && /"(?:checkout_auth_token|customer_session_secret|refresh_token|checkout_session_id|superseding_checkout_session_id|recovery_payment_attempt_id)"\s*:/.test(value)) this.violations.add('PRIVATE_DTO_FIELD');
    if (url) {
      if (url.username || url.password || decodedValues((remainder ?? url).search).some(search => /(?:email|password|code|client_secret|access_token|checkout_auth_token)=/i.test(search))) this.violations.add('SENSITIVE_URL');
    }
    if (this.violations.size !== count) { this.#surfaces.add(surface); for (const listener of this.listeners) listener(); }
  }
  assertClean(): void { invariant(this.violations.size === 0, 'CREDENTIAL_LEAK'); }
}
