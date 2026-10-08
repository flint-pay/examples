// @ts-check
// Behavior shared by every page: dialogs, busy forms, collapsible summaries, focus on errors.

/** Native <dialog> support with focus returned to the control that opened it. */
function setupDialogs() {
  /** @type {WeakMap<HTMLDialogElement, HTMLElement>} */
  const openers = new WeakMap();
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const opener = target.closest('[data-dialog-open]');
    if (opener instanceof HTMLElement) {
      const dialog = document.getElementById(opener.dataset.dialogOpen ?? '');
      if (dialog instanceof HTMLDialogElement) {
        openers.set(dialog, opener);
        dialog.showModal();
      }
      return;
    }
    const closer = target.closest('[data-dialog-close]');
    if (closer) {
      const dialog = closer.closest('dialog');
      if (dialog instanceof HTMLDialogElement) dialog.close();
    }
  });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('close', () => {
      const opener = openers.get(dialog);
      if (opener) opener.focus();
    });
    // A click on the backdrop closes the dialog, like Escape.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    if (dialog.dataset.openOnLoad === 'true') dialog.showModal();
  }
}

/** Keeps a second submit from going through while the first is in flight. Labels do not change. */
function setupBusyForms() {
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
    if (event.defaultPrevented) return;
    if (form.dataset.submitting === 'true') {
      event.preventDefault();
      return;
    }
    form.dataset.submitting = 'true';
    for (const button of form.querySelectorAll('button[type="submit"]')) button.setAttribute('aria-busy', 'true');
  });
  // Coming back through the history restores the page with its forms usable again.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    for (const form of document.querySelectorAll('form[data-submitting]')) {
      if (form instanceof HTMLFormElement) delete form.dataset.submitting;
    }
    for (const button of document.querySelectorAll('button[aria-busy="true"]')) {
      if (button.closest('[data-payment-root]')) continue;
      button.removeAttribute('aria-busy');
    }
  });
}

/** Order summaries collapse below 1024px and stay open above it. */
function setupCollapsibles() {
  const query = window.matchMedia('(min-width: 1024px)');
  const apply = () => {
    for (const details of document.querySelectorAll('details[data-collapse-narrow]')) {
      if (details instanceof HTMLDetailsElement) details.open = query.matches;
    }
  };
  apply();
  query.addEventListener('change', apply);
}

function focusFirstError() {
  const target = document.querySelector('[data-autofocus]');
  if (target instanceof HTMLElement) {
    target.focus({ preventScroll: false });
    return;
  }
}

function setupPrint() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-print]') : null;
    if (target) window.print();
  });
}

setupDialogs();
setupBusyForms();
setupCollapsibles();
setupPrint();
focusFirstError();
