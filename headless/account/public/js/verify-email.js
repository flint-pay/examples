// @ts-check
// Enables "Send a new code" 30 seconds after the last code was sent and says why until then.

const form = document.querySelector('[data-resend-form]');
if (form instanceof HTMLFormElement) {
  const button = form.querySelector('[data-resend-button]');
  const note = form.querySelector('[data-resend-note]');
  const wait = Number(form.dataset.resendWait ?? '30');
  const sentAt = Number(form.dataset.sentAt ?? '');
  const label = form.dataset.resendLabel ?? '';
  const waitLabel = form.dataset.resendWaitLabel ?? '';
  if (button instanceof HTMLButtonElement && note instanceof HTMLElement && Number.isFinite(sentAt) && sentAt > 0) {
    const remaining = () => {
      // Clamp so a clock that disagrees with the server never locks the button for long.
      const elapsed = (Date.now() - sentAt) / 1000;
      return Math.max(0, Math.min(wait, Math.ceil(wait - elapsed)));
    };
    const tick = () => {
      const left = remaining();
      if (left > 0) {
        button.disabled = true;
        note.textContent = waitLabel.replace('{seconds}', String(left));
        window.setTimeout(tick, 1000);
      } else {
        button.disabled = false;
        note.textContent = '';
        button.textContent = label;
      }
    };
    tick();
  }
}
