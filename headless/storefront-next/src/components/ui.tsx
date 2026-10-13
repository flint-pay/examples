import { errorKey, fill, hasMessage, message, parseNotice, toneFor, type Params } from '@/shared/copy.ts';
import { AlertIcon, CheckIcon, InfoIcon } from './icons.tsx';

// Presentational pieces shared by server and client components. No state, no hooks.

export function Notice({ tone, children, testid, notice }: { tone: 'info' | 'success' | 'warning' | 'error'; children: React.ReactNode; testid?: string; notice?: string }) {
  const Icon = tone === 'success' ? CheckIcon : tone === 'info' ? InfoIcon : AlertIcon;
  return (
    <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testid} data-notice={notice}>
      <Icon />
      <div>{children}</div>
    </div>
  );
}

/** Notices arrive as copy keys. Unknown keys are skipped so an internal key never reaches a buyer. */
export function Notices({ keys, params = {} }: { keys: string[]; params?: Params }) {
  const items = [...new Set(keys)].map(parseNotice).filter(({ key }) => hasMessage(key));
  return (
    <div className="notices" data-testid="sf-notices">
      {items.map(({ key, param }) => (
        <Notice key={key} tone={toneFor(key)} testid={`sf-notice-${key}`} notice={key}>
          <p>{message(key, { n: param, amount: param, email: param, ...params })}</p>
        </Notice>
      ))}
    </div>
  );
}

export type ErrorShape = { kind?: string; code?: string; message_key?: string; request_id?: string };

export function ErrorNotice({ error, params = {}, id }: { error: ErrorShape | undefined; params?: Params; id?: string }) {
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert" data-testid="sf-error-message" tabIndex={-1} id={id}>
      <AlertIcon />
      <div>
        <p>{message(errorKey(error), params)}</p>
        {error.request_id ? <p className="reference">{fill(message('reference_id'), { id: error.request_id })}</p> : null}
      </div>
    </div>
  );
}

export type FieldProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  testid?: string;
  ref?: React.Ref<HTMLInputElement>;
};

export function Field({ id, label, hint, error, optional, testid, className, ref, ...input }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>
        {label}
        {optional ? <span className="optional"> (optional)</span> : null}
      </label>
      <input ref={ref} id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} data-testid={testid} {...input} />
      {hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="field-error" id={`${id}-error`} data-testid={`${testid ?? id}-error`}>{error}</p> : null}
    </div>
  );
}

export function MoneyText({ value, text, testid }: { value: { amount: string; currency: string } | null | undefined; text: string; testid?: string }) {
  return (
    <span className="money" data-amount-minor={value?.amount} data-currency={value?.currency} data-testid={testid}>
      {text}
    </span>
  );
}

export function productImage(slug: string | undefined): string {
  return slug ? `/images/${slug}.svg` : '/images/house-blend.svg';
}
