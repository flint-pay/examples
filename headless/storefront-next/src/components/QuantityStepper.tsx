'use client';

import { copy, fill } from '@/shared/copy.ts';

export const MAX_QUANTITY = 20;

/**
 * A number field with minus and plus buttons. The buttons report each step; typing reports on every
 * keystroke through `onType`, so a caller can wait for an explicit save instead of saving mid-word.
 */
export function QuantityStepper({ id, name, value, onChange, onType, itemName, testid, disabled, small }: { id: string; name: string; value: number; onChange: (value: number) => void; onType?: (value: number) => void; itemName: string; testid?: string; disabled?: boolean; small?: boolean }) {
  const set = (next: number) => onChange(Math.max(1, Math.min(MAX_QUANTITY, next)));
  const typed = onType ?? onChange;
  return (
    <div className={`stepper${small ? ' stepper-small' : ''}`}>
      <button type="button" onClick={() => set(value - 1)} disabled={disabled || value <= 1} aria-label={fill(copy.cart.decrease, { name: itemName })}>−</button>
      <label htmlFor={id} className="visually-hidden">{fill(copy.cart.quantityFor, { name: itemName })}</label>
      <input id={id} name={name} type="number" min={1} max={MAX_QUANTITY} step={1} inputMode="numeric" value={value || ''} disabled={disabled} required data-testid={testid}
        onChange={(event) => { const next = Number(event.target.value); typed(Number.isFinite(next) ? Math.max(0, Math.min(MAX_QUANTITY, Math.trunc(next))) : 0); }} />
      <button type="button" onClick={() => set(value + 1)} disabled={disabled || value >= MAX_QUANTITY} aria-label={fill(copy.cart.increase, { name: itemName })}>+</button>
    </div>
  );
}
