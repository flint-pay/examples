'use client';

import { useEffect, useRef, useState } from 'react';
import * as logic from '@/shared/checkout-logic.ts';
import { copy, fill, message } from '@/shared/copy.ts';
import { addressLine, formatDay } from '@/shared/format.ts';
import { formatMoney, isZero, minorToDecimal } from '@/shared/money.ts';
import type { Address, CheckoutState, DeliveryOption, PickupLocation } from '@/shared/types.ts';
import { StoreIcon, TruckIcon } from '../icons.tsx';
import { Field, MoneyText, Notice } from '../ui.tsx';
import { StepHeading, useCheckout } from './CheckoutClient.tsx';

const POSTAL = logic.US_POSTAL_CODE;

type AddressFields = { line1: string; line2: string; city: string; state: string; postal_code: string };
const fromAddress = (address: Address | null | undefined): AddressFields => ({ line1: address?.line1 ?? '', line2: address?.line2 ?? '', city: address?.city ?? '', state: address?.state ?? '', postal_code: address?.postal_code ?? '' });

function AddressInputs({ prefix, values, onChange, invalid, kind, autoFocusFirst }: { prefix: 'ship' | 'bill'; values: AddressFields; onChange: (next: AddressFields) => void; invalid?: string; kind: 'shipping' | 'billing'; autoFocusFirst?: boolean }) {
  const set = (name: keyof AddressFields) => (event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...values, [name]: event.target.value });
  const mark = (name: string) => (invalid === name ? message(name === 'postal_code' ? 'billing_postal_code_required' : 'billing_address_incomplete') : undefined);
  return (
    <>
      <Field id={`${prefix}-line1`} name="line1" label={copy.checkout.line1} value={values.line1} onChange={set('line1')} required autoComplete={`${kind} address-line1`} testid={`sf-${prefix}-line1`} error={mark('line1')} autoFocus={autoFocusFirst} />
      <Field id={`${prefix}-line2`} name="line2" label={copy.checkout.line2Short} optional value={values.line2} onChange={set('line2')} autoComplete={`${kind} address-line2`} testid={`sf-${prefix}-line2`} />
      <div className="field-row field-row-3">
        <Field id={`${prefix}-city`} name="city" label={copy.checkout.city} value={values.city} onChange={set('city')} required autoComplete={`${kind} address-level2`} testid={`sf-${prefix}-city`} error={mark('city')} />
        <Field id={`${prefix}-state`} name="state" label={copy.checkout.state} value={values.state} onChange={(event) => onChange({ ...values, state: event.target.value.toUpperCase() })} required autoComplete={`${kind} address-level1`} maxLength={2} testid={`sf-${prefix}-state`} error={mark('state')} />
        <Field id={`${prefix}-postal`} name="postal_code" label={copy.checkout.postalCode} value={values.postal_code} onChange={set('postal_code')} required autoComplete={`${kind} postal-code`} inputMode="numeric" testid={`sf-${prefix}-postal`} error={mark('postal_code')} />
      </div>
      <p className="hint flush">{copy.checkout.shipsWithinUs}</p>
    </>
  );
}

function addressBody(values: AddressFields) {
  return {
    line1: values.line1.trim(),
    ...(values.line2.trim() ? { line2: values.line2.trim() } : {}),
    city: values.city.trim(),
    state: values.state.trim().toUpperCase(),
    postal_code: values.postal_code.trim(),
    country: 'US',
  };
}

function addressFailure(values: AddressFields): string {
  for (const name of ['line1', 'city', 'state', 'postal_code'] as const) if (!values[name].trim()) return name;
  if (!/^[A-Za-z]{2}$/.test(values.state.trim())) return 'state';
  if (!POSTAL.test(values.postal_code.trim())) return 'postal_code';
  return '';
}

// ----- Delivery -----

function optionParts(option: DeliveryOption): { title: string; detail: React.ReactNode; price: React.ReactNode } {
  const priceText = option.amount_money && isZero(option.amount_money) ? copy.checkout.free : formatMoney(option.amount_money);
  if (option.type === 'pickup') {
    const location = option.pickup?.location;
    const meters = (option as PickupLocation).distance_meters;
    const distance = typeof meters === 'number' ? meters / 1609.344 : null;
    return {
      title: location?.name ?? option.name,
      detail: (
        <>
          {addressLine(location?.address)}
          {distance !== null ? <span className="choice-detail"> · {fill(copy.checkout.pickupDistance, { distance: distance.toFixed(1) })}</span> : null}
          {location?.instructions ? <span className="choice-note">{location.instructions}</span> : null}
        </>
      ),
      price: option.amount_money ? <MoneyText value={option.amount_money} text={priceText} /> : <span>{copy.checkout.free}</span>,
    };
  }
  const estimate = option.arrival_estimate;
  const arrives = estimate
    ? estimate.earliest_date === estimate.latest_date
      ? fill(copy.checkout.arrivesOn, { date: formatDay(estimate.earliest_date) })
      : fill(copy.checkout.arrives, { earliest: formatDay(estimate.earliest_date), latest: formatDay(estimate.latest_date) })
    : '';
  return { title: option.name, detail: arrives, price: <MoneyText value={option.amount_money} text={priceText} /> };
}

type ListGroup = { id: string; names: string[]; options: DeliveryOption[] };

function listGroups(state: CheckoutState, type: 'ship' | 'pickup'): ListGroup[] {
  const quoteGroups = state.delivery_quote?.choice_groups ?? [];
  const names = (id: string) => (quoteGroups.find((group) => group.delivery_choice_group_id === id)?.line_items ?? []).map((item) => item.name).filter((name): name is string => Boolean(name));
  if (type === 'pickup') {
    const grouped = new Map<string, DeliveryOption[]>();
    for (const item of logic.pickupOptions(state)) grouped.set(item.delivery_choice_group_id, [...(grouped.get(item.delivery_choice_group_id) ?? []), item]);
    return [...grouped].map(([id, options]) => ({ id, names: names(id), options }));
  }
  return quoteGroups
    .map((group) => ({ id: group.delivery_choice_group_id, names: names(group.delivery_choice_group_id), options: group.options.filter((option) => option.type !== 'pickup') }))
    .filter((group) => group.options.length > 0);
}

function OptionsList({ state, type, onPick }: { state: CheckoutState; type: 'ship' | 'pickup'; onPick: (single: boolean) => void }) {
  const groups = listGroups(state, type);
  const testid = type === 'pickup' ? 'sf-pickup-location' : 'sf-delivery-option';
  let index = 0;
  return (
    <>
      {groups.map((group) => {
        const legend = groups.length > 1
          ? group.names.length ? fill(copy.checkout.groupLegendItems, { items: group.names.join(', ') }) : copy.checkout.groupLegend
          : type === 'pickup' ? copy.checkout.pickupLegend : copy.checkout.optionsLegend;
        return (
          <fieldset key={group.id} data-group-id={group.id}>
            <legend className="choice-legend">{legend}</legend>
            <div className="choices">
              {group.options.map((option) => {
                const position = index++;
                const parts = optionParts(option);
                const id = `opt-${type}-${position}`;
                return (
                  <label className="choice-card" htmlFor={id} key={id}>
                    <input id={id} type="radio" name={`group-${group.id}`} value={option.delivery_option_id ?? option.delivery_method_id} data-group-id={group.id} data-testid={`${testid}-${position}`}
                      // A pointer click on the only choice group submits. Arrow keys only move the selection.
                      onClick={(event) => onPick(event.detail > 0 && groups.length === 1)} />
                    <span className="choice-body"><span className="choice-title">{parts.title}</span>{parts.detail ? <span className="choice-detail">{parts.detail}</span> : null}</span>
                    <span className="choice-price">{parts.price}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </>
  );
}

function SelectedDelivery({ state, onChange, editing }: { state: CheckoutState; onChange: () => void; editing: boolean }) {
  const selection = state.delivery_selection!;
  const choice = selection.choices[0];
  if (!choice) return null;
  const price = selection.amount_money && isZero(selection.amount_money) ? copy.checkout.free : formatMoney(selection.amount_money);
  const where = choice.type === 'pickup'
    ? fill(copy.checkout.pickupAt, { name: choice.pickup?.location?.name ?? choice.name })
    : fill(copy.checkout.shipTo, { name: selection.recipient?.name ?? '', address: addressLine(selection.destination_address) }).replace(/^Ship to ,\s*/, 'Ship to ');
  const estimate = choice.arrival_estimate ? fill(copy.checkout.arrives, { earliest: formatDay(choice.arrival_estimate.earliest_date), latest: formatDay(choice.arrival_estimate.latest_date) }) : '';
  return (
    <div className="step-summary" data-testid="sf-delivery-selected" data-selection-id={selection.delivery_selection_id}>
      <div>
        <p className="choice-title">{choice.name} · <MoneyText value={selection.amount_money} text={price} /></p>
        <p className="summary-detail">{where}</p>
        {estimate ? <p className="summary-detail">{estimate}</p> : null}
      </div>
      <button className="button button-small" type="button" onClick={onChange} aria-expanded={editing} aria-controls="delivery-edit">{copy.checkout.change}</button>
    </div>
  );
}

export function DeliverySection({ step }: { step: number }) {
  const { controller, snap } = useCheckout();
  const state = snap.state;
  let stateName = logic.deliveryState(state) ?? 'idle';
  const serverMode = logic.deliveryMode(state);
  const modes = logic.deliveryModes(state);
  const [mode, setMode] = useState<'ship' | 'pickup'>(serverMode);
  const quote = state.delivery_quote;
  const prefill = state.delivery_selection?.destination_address ?? quote?.destination_address ?? state.session.customer_prefill?.shipping_address ?? null;
  const [address, setAddress] = useState<AddressFields>(() => fromAddress(prefill));
  const [recipient, setRecipient] = useState(() => state.delivery_selection?.recipient?.name ?? snap.contact.name);
  const [postal, setPostal] = useState(state.pickup_search?.postal_code ?? '');
  const [invalid, setInvalid] = useState('');
  const [editing, setEditing] = useState(false);
  const shipForm = useRef<HTMLFormElement>(null);
  const pickupForm = useRef<HTMLFormElement>(null);
  const live = useRef({ mode, address, postal });
  live.current = { mode, address, postal };

  const ship = listGroups(state, 'ship').reduce((sum, group) => sum + group.options.length, 0);
  const pickup = listGroups(state, 'pickup').reduce((sum, group) => sum + group.options.length, 0);
  if (stateName === 'options' && ((serverMode === 'ship' && ship === 0) || (serverMode === 'pickup' && pickup === 0))) stateName = 'unavailable';
  if (stateName === 'unavailable' && serverMode === 'pickup' && logic.pickupNoneNearby(state)) stateName = 'none_nearby';
  const selected = stateName === 'selected' || (stateName === 'needs_input' && Boolean(state.delivery_selection));
  const done = stateName === 'selected';
  const reasons = quote?.buyer_reasons ?? [];
  const queued = (kind: 'delivery-quote' | 'pickup-locations' | 'delivery-select') => controller.isQueued(kind);

  // The server's mode wins once it knows more, for example after a quote or a selection.
  useEffect(() => setMode(serverMode), [serverMode]);
  // A failed payment can ask the buyer to choose again, which reopens the section.
  useEffect(() => { if (snap.deliveryOpen) setEditing(true); }, [snap.deliveryOpen]);
  useEffect(() => { if (!selected) setEditing(false); }, [selected]);

  useEffect(() => {
    controller.deliveryForms = {
      mode: () => live.current.mode,
      ship: () => {
        const values = live.current.address;
        return ['line1', 'city', 'postal_code'].every((name) => values[name as keyof AddressFields].trim()) ? { destination_address: addressBody(values) } : null;
      },
      pickup: () => (live.current.postal.trim() ? { postal_code: live.current.postal.trim(), country: 'US' } : null),
    };
    return () => { controller.deliveryForms = null; };
  }, [controller]);
  useEffect(() => controller.maybeAutoRequote(), [controller, stateName, state.delivery_selection?.delivery_selection_id]);

  function quoteAddress(event: React.FormEvent) {
    event.preventDefault();
    const failed = addressFailure(address);
    if (failed) {
      setInvalid(failed);
      controller.showJobError('delivery', message(failed === 'postal_code' && address.postal_code.trim() ? 'delivery_postal_code_required' : 'delivery_address_incomplete'));
      document.getElementById(`ship-${failed === 'postal_code' ? 'postal' : failed.replace('_code', '')}`)?.focus();
      return;
    }
    setInvalid('');
    void controller.job('delivery-quote', { destination_address: addressBody(address) });
  }

  function searchPickup(event: React.FormEvent) {
    event.preventDefault();
    if (!POSTAL.test(postal.trim())) {
      controller.showJobError('delivery', message('delivery_postal_code_required'));
      document.getElementById('pickup-postal')?.focus();
      return;
    }
    void controller.job('pickup-locations', { postal_code: postal.trim(), country: 'US' });
  }

  function select(form: HTMLFormElement, pickupSelect: boolean) {
    const groups = new Set([...form.querySelectorAll('fieldset[data-group-id]')].map((set) => set.getAttribute('data-group-id')));
    const checked = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')];
    const chosen = new Set(checked.map((input) => input.getAttribute('data-group-id')));
    if (chosen.size < groups.size || chosen.size === 0) {
      controller.showJobError('delivery', message('delivery_choice_required'));
      return;
    }
    const c = snap.contact;
    const name = mode === 'ship' ? recipient.trim() || c.name.trim() : c.name.trim();
    const person = { name, ...(c.email.trim() ? { email: c.email.trim() } : {}), ...(c.phone.trim() ? { phone: c.phone.trim() } : {}) };
    // A pickup location is discovered by search, so the server quotes it before it selects.
    if (pickupSelect) void controller.job('delivery-select', { pickup_location_id: checked[0]!.value, recipient: person });
    else void controller.job('delivery-select', { choices: checked.map((input) => ({ delivery_choice_group_id: input.getAttribute('data-group-id') ?? '', delivery_option_id: input.value })), recipient: person });
  }

  return (
    <section className="step" id="delivery" aria-labelledby="delivery-title" data-section="delivery" data-region="delivery" data-testid="sf-delivery" data-state={stateName} data-mode={mode} data-done={done}>
      <StepHeading id="delivery-title" step={step} done={done} title={copy.checkout.deliveryHeading} />
      <fieldset disabled={snap.locked} className="stack">
        {selected ? <SelectedDelivery state={state} editing={editing} onChange={() => setEditing(!editing)} /> : null}
        {stateName === 'needs_input' ? <Notice tone="warning" testid="sf-delivery-needs-input"><p><a href="#contact-phone" onClick={(event) => { event.preventDefault(); document.getElementById('contact-phone')?.focus(); }}>{message('delivery_phone_needed')}</a></p></Notice> : null}
        {stateName === 'stale' ? <Notice tone="warning" testid="sf-delivery-stale"><p>{message('delivery_prices_changed')}</p></Notice> : null}
        {stateName === 'none_nearby' ? <Notice tone="warning" testid="sf-pickup-none"><p>{fill(message('pickup_none_nearby'), { postal_code: state.pickup_search?.postal_code ?? '' })}</p></Notice> : null}
        {stateName === 'unavailable' ? <Notice tone="warning" testid="sf-delivery-unavailable"><p>{message('delivery_unavailable')}</p>{reasons.length ? <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}</Notice> : null}
        <div id="delivery-edit" className="stack" hidden={selected && !editing}>
          {modes.length > 1 ? (
            <fieldset>
              <legend className="visually-hidden">{copy.checkout.deliveryModeLegend}</legend>
              <div className="mode-tabs">
                {modes.includes('ship') ? <label className="mode-tab"><input type="radio" name="delivery-mode" value="ship" checked={mode === 'ship'} onChange={() => setMode('ship')} data-testid="sf-delivery-mode-ship" /><TruckIcon />{copy.checkout.modeShipShort}</label> : null}
                {modes.includes('pickup') ? <label className="mode-tab"><input type="radio" name="delivery-mode" value="pickup" checked={mode === 'pickup'} onChange={() => setMode('pickup')} data-testid="sf-delivery-mode-pickup" /><StoreIcon />{copy.checkout.modePickupShort}</label> : null}
              </div>
            </fieldset>
          ) : null}
          {modes.includes('ship') ? (
            <div data-delivery-panel="ship" hidden={mode !== 'ship'} className="stack">
              <form noValidate className="stack" onSubmit={quoteAddress} data-testid="sf-delivery-address">
                <Field id="ship-name" name="recipient_name" label={copy.checkout.recipientName} value={recipient} onChange={(event) => setRecipient(event.target.value)} required autoComplete="shipping name" testid="sf-ship-name" />
                <AddressInputs prefix="ship" kind="shipping" values={address} onChange={(next) => { setAddress(next); setInvalid(''); }} invalid={invalid} />
                <div className="actions"><button className="button button-dark" type="submit" aria-busy={queued('delivery-quote')} disabled={queued('delivery-quote')} data-testid="sf-delivery-quote">{ship ? copy.checkout.updateDeliveryOptions : copy.checkout.showDeliveryOptions}</button></div>
              </form>
              <div aria-live="polite">
                {ship ? (
                  <form ref={shipForm} noValidate className="stack" onSubmit={(event) => { event.preventDefault(); select(event.currentTarget, false); }} data-testid="sf-delivery-options">
                    <OptionsList state={state} type="ship" onPick={(single) => { if (single) shipForm.current?.requestSubmit(); }} />
                    <div className="actions"><button className="button button-primary" type="submit" aria-busy={queued('delivery-select')} disabled={queued('delivery-select')} data-testid="sf-delivery-choose">{copy.checkout.choose}</button></div>
                  </form>
                ) : null}
              </div>
            </div>
          ) : null}
          {modes.includes('pickup') ? (
            <div data-delivery-panel="pickup" hidden={mode !== 'pickup'} className="stack">
              <form noValidate className="inline-field" onSubmit={searchPickup} data-testid="sf-pickup-form">
                <Field id="pickup-postal" name="postal_code" label={copy.checkout.pickupPostal} value={postal} onChange={(event) => setPostal(event.target.value)} required autoComplete="postal-code" inputMode="numeric" testid="sf-pickup-postal" />
                <button className="button button-dark" type="submit" aria-busy={queued('pickup-locations')} disabled={queued('pickup-locations')} data-testid="sf-pickup-search">{copy.checkout.findPickup}</button>
              </form>
              <div aria-live="polite">
                {pickup ? (
                  <form ref={pickupForm} noValidate className="stack" onSubmit={(event) => { event.preventDefault(); select(event.currentTarget, true); }} data-testid="sf-pickup-options" data-pickup-select>
                    <OptionsList state={state} type="pickup" onPick={() => undefined} />
                    <div className="actions"><button className="button button-primary" type="submit" aria-busy={queued('delivery-select')} disabled={queued('delivery-select')} data-testid="sf-pickup-select">{copy.checkout.pickupSelect}</button></div>
                  </form>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </fieldset>
      <p className="field-error" role="alert" data-job-error="delivery" data-testid="sf-delivery-error" hidden={!snap.jobErrors.delivery}>{snap.jobErrors.delivery}</p>
    </section>
  );
}

// ----- Billing address for tax -----

export function BillingSection({ step }: { step: number }) {
  const { controller, snap } = useCheckout();
  const state = snap.state;
  const stateName = logic.taxLocationState(state);
  const prefill = state.billing_address ?? state.order.tax?.location?.address ?? null;
  const [values, setValues] = useState<AddressFields>(() => fromAddress(prefill));
  const [invalid, setInvalid] = useState('');
  const [editing, setEditing] = useState(false);
  const set = stateName === 'set';
  useEffect(() => { if (set) setEditing(false); }, [set, prefill?.line1, prefill?.postal_code]);
  if (!stateName) return null;
  const queued = controller.isQueued('billing-address');

  function save(event: React.FormEvent) {
    event.preventDefault();
    const failed = addressFailure(values);
    if (failed) {
      setInvalid(failed);
      controller.showJobError('billing', message(failed === 'postal_code' && values.postal_code.trim() ? 'billing_postal_code_required' : 'billing_address_incomplete'));
      document.getElementById(`bill-${failed === 'postal_code' ? 'postal' : failed}`)?.focus();
      return;
    }
    setInvalid('');
    void controller.job('billing-address', addressBody(values));
  }

  return (
    <section className="step" id="billing" aria-labelledby="billing-title" data-section="billing" data-region="billing" data-testid="sf-billing" data-state={stateName} data-done={set}>
      <StepHeading id="billing-title" step={step} done={set} title={copy.checkout.billingHeading} />
      <fieldset disabled={snap.locked} className="stack">
        {set ? (
          <div className="step-summary" data-testid="sf-billing-selected">
            <p className="summary-detail">{addressLine(prefill)}</p>
            <button className="button button-small" type="button" onClick={() => setEditing(!editing)} aria-expanded={editing} aria-controls="billing-edit">{copy.checkout.change}</button>
          </div>
        ) : <p className="hint flush">{copy.checkout.billingWhy}</p>}
        <div id="billing-edit" hidden={set && !editing}>
          <form noValidate className="stack" onSubmit={save} data-testid="sf-billing-address">
            <AddressInputs prefix="bill" kind="billing" values={values} onChange={(next) => { setValues(next); setInvalid(''); }} invalid={invalid} />
            <div className="actions"><button className="button button-dark" type="submit" aria-busy={queued} disabled={queued} data-testid="sf-billing-save">{copy.checkout.saveBillingAddress}</button></div>
          </form>
        </div>
      </fieldset>
      <p className="field-error" role="alert" data-job-error="billing" hidden={!snap.jobErrors.billing}>{snap.jobErrors.billing}</p>
    </section>
  );
}

// ----- Tip -----

export function TipSection() {
  const { controller, snap } = useCheckout();
  const state = snap.state;
  const visible = logic.tipVisible(state);
  const choice = logic.tipChoice(state);
  const custom = logic.requestedTip(state)?.amount_money;
  const [selected, setSelected] = useState<string>(choice);
  const [amount, setAmount] = useState(custom ? minorToDecimal(custom.amount, custom.currency) : '');
  useEffect(() => setSelected(choice), [choice]);
  if (!visible) return null;
  const queued = controller.isQueued('tip');
  const options = [{ value: 'none', label: copy.checkout.tipNone }, ...logic.TIP_PERCENTS.map((percent) => ({ value: String(percent), label: `${percent}%` })), { value: 'custom', label: copy.checkout.tipCustom }];

  function send(value: string) {
    if (value === 'custom' && !/^\d+(\.\d{1,2})?$/.test(amount.trim())) {
      controller.showJobError('tip', message('tip_invalid'));
      document.getElementById('tip-custom')?.focus();
      return;
    }
    void controller.job('tip', value === 'none' ? { clear: true } : value === 'custom' ? { amount: amount.trim() } : { percent: Number(value) });
  }

  return (
    <section className="step" id="tip" aria-labelledby="tip-title" data-section="tip" data-region="tip">
      <StepHeading id="tip-title" title={copy.checkout.tipHeading} />
      <form noValidate className="stack" data-testid="sf-tip" onSubmit={(event) => { event.preventDefault(); send(selected); }}>
        <fieldset disabled={snap.locked}>
          <legend className="choice-legend">{copy.checkout.tipLegend}</legend>
          <div className="segmented">
            {options.map((option) => (
              <label key={option.value}>
                <input type="radio" name="tip" value={option.value} checked={selected === option.value} data-testid={`sf-tip-${option.value}`}
                  onChange={() => setSelected(option.value)}
                  onClick={(event) => {
                    if (option.value === 'custom') window.setTimeout(() => document.getElementById('tip-custom')?.focus(), 0);
                    else if (event.detail > 0) send(option.value);
                  }} />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {selected === 'custom' ? (
          <div className="inline-field">
            <Field id="tip-custom" name="amount" label={copy.checkout.tipCustomLabel} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" testid="sf-tip-custom-amount" disabled={snap.locked} />
            <button className="button button-dark" type="submit" aria-busy={queued} disabled={queued || snap.locked} data-testid="sf-tip-apply">{copy.checkout.tipApply}</button>
          </div>
        ) : (
          <button className="visually-hidden" type="submit" tabIndex={-1} data-testid="sf-tip-apply" disabled={queued || snap.locked}>{copy.checkout.tipApply}</button>
        )}
      </form>
      <p className="field-error" role="alert" data-job-error="tip" hidden={!snap.jobErrors.tip}>{snap.jobErrors.tip}</p>
    </section>
  );
}
