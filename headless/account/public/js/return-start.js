// @ts-check
// Shows quantity, reason, and note only for the items the buyer picked, and marks the reason
// required for those. Without JavaScript every field is visible and the server validates.

for (const line of document.querySelectorAll('[data-return-line]')) {
  const checkbox = line.querySelector('[data-return-select]');
  const fields = line.querySelector('[data-return-fields]');
  const reason = line.querySelector('[data-return-reason]');
  const note = line.querySelector('textarea');
  if (!(checkbox instanceof HTMLInputElement) || !(fields instanceof HTMLElement)) continue;

  const update = () => {
    fields.hidden = !checkbox.checked;
    if (line instanceof HTMLElement) line.dataset.state = checkbox.checked ? 'selected' : 'idle';
    if (reason instanceof HTMLSelectElement) {
      reason.required = checkbox.checked;
      const option = reason.selectedOptions[0];
      const noteRequired = checkbox.checked && option?.dataset.noteRequired === 'true';
      if (note instanceof HTMLTextAreaElement) note.required = noteRequired;
    }
  };
  checkbox.addEventListener('change', update);
  if (reason instanceof HTMLSelectElement) reason.addEventListener('change', update);
  update();
}
