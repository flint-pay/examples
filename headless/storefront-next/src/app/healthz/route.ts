import { SDK_VERSION } from '@/server/config.ts';
import { runtime } from '@/server/runtime.ts';

export async function GET() {
  try {
    const { preflight, config } = await runtime();
    return Response.json({ status: 'ok', app: 'storefront-next', sandbox_id: preflight.sandboxId, mode: 'test', sdk_version: SDK_VERSION, cards: preflight.cards, ...(config.build ? { build: config.build } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
