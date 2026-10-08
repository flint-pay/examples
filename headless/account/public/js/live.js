// @ts-check
// One polite live region (role=status) shared by every module on the page.

/** @param {string} message */
export function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  // Clearing first makes screen readers announce a repeated message.
  window.setTimeout(() => {
    region.textContent = message;
  }, 30);
}
