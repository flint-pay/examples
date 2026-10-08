export function returnPath(value: unknown, fallback='/'): string {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
    const url = new URL(value, 'https://return.invalid');
    return url.origin === 'https://return.invalid' ? url.pathname + url.search + url.hash : fallback;
  } catch { return fallback; }
}
