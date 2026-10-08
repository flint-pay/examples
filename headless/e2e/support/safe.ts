import { createHash } from 'node:crypto';

export class HarnessError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'HarnessError'; this.code = code; }
}
export function invariant(value: unknown, code: string): asserts value {
  if (!value) throw new HarnessError(code);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  invariant(value !== undefined && typeof value !== 'bigint', 'INVALID_DURABLE_REQUEST');
  return JSON.stringify(value);
}
// Raw SDK, Playwright and child errors must never be printed, even on setup failure.
export function safeFailure(error: unknown): string {
  if (error instanceof HarnessError && /^[A-Z][A-Z0-9_-]{1,80}$/.test(error.code)) return error.code;
  const failure = apiFailure(error); return failure.status && failure.code ? failure.code : 'EXECUTION_FAILED';
}
export function requestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
}
export function apiFailure(error: unknown): { status?: number; code?: string; requestId?: string } {
  const e = error as { status?: number; statusCode?: number; code?: string; meta?: { status?: number; headers?: Record<string, string> }; requestId?: string };
  return { status: e?.status ?? e?.statusCode ?? e?.meta?.status,
    code: typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(e.code) ? e.code : undefined,
    requestId: requestId(e?.requestId ?? e?.meta?.headers?.['x-request-id']) };
}
export function emit(value: { event: string; code?: string; count?: number; row?: string; status?: string }): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
