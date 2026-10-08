// Marks the document as script-enabled before first paint so no-JS fallbacks never flash.
document.documentElement.classList.replace('no-js', 'js');
// A provider script that fails to load fires an error event on its own element before the page
// modules run. Record it so they can tell the buyer instead of waiting.
window.addEventListener(
  'error',
  (event) => {
    const target = event.target;
    if (target instanceof HTMLScriptElement && target.hasAttribute('data-stripe-script')) {
      document.documentElement.dataset.stripeFailed = 'true';
    }
  },
  true,
);
