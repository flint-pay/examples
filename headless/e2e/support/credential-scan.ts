import { invariant } from './safe.ts';

export type Surface = 'url' | 'cookie' | 'storage' | 'dom' | 'body' | 'console' | 'child' | 'request';
export type ScanContext = { providerJob?: boolean; sensitiveInput?: boolean; submittedGift?: boolean; stripeTransport?: boolean;challengeProofSubmit?:boolean };
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
    if (/(flint_(?:test|live|cses|cref)_|ckat_|cklt_|whsec_)[A-Za-z0-9_-]+/.test(value) || [...this.#secrets].some(s => value.includes(s))) this.violations.add(`CREDENTIAL_${surface.toUpperCase()}`);
    const proofs=value.match(/gccp_[A-Za-z0-9_-]{20,}/g)??[];
    if(proofs.length){
      if(surface==='request'&&context.challengeProofSubmit)for(const proof of proofs)this.#secrets.add(proof);
      else this.violations.add(`CHALLENGE_PROOF_${surface.toUpperCase()}`);
    }
    if ([...this.#giftSecrets].some(s => value.includes(s)) && !(surface === 'request' && context.submittedGift) && !(surface === 'dom' && context.sensitiveInput)) this.violations.add(`GIFT_AUTHORITY_${surface.toUpperCase()}`);
    if (/[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+/.test(value) && !(surface === 'body' && context.providerJob) && !(surface === 'request' && context.stripeTransport)) this.violations.add(`PROVIDER_SECRET_${surface.toUpperCase()}`);
    if (surface === 'body' && /"(?:checkout_auth_token|customer_session_secret|refresh_token|checkout_session_id|superseding_checkout_session_id|recovery_payment_attempt_id)"\s*:/.test(value)) this.violations.add('PRIVATE_DTO_FIELD');
    if (surface === 'url') {
      try {
        const url = new URL(value);
        if (url.username || url.password || /(?:email|password|code|client_secret|access_token|checkout_auth_token)=/i.test(url.search)) this.violations.add('SENSITIVE_URL');
      } catch { this.violations.add('INVALID_URL'); }
    }
    if (this.violations.size !== count) { this.#surfaces.add(surface); for (const listener of this.listeners) listener(); }
  }
  assertClean(): void { invariant(this.violations.size === 0, 'CREDENTIAL_LEAK'); }
}
