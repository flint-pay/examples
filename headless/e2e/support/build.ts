import { invariant } from './safe.ts';
import type { Config } from './config.ts';

async function verify(config: Config, services: [string, string][], healthFetch: typeof fetch): Promise<void> {
  for (const [name, appOrigin] of services) {
    const path = config.healthPaths?.[name] ?? (name === 'api' ? '/health' : '/healthz');
    invariant(/^\/[A-Za-z0-9/_-]+$/.test(path) && !path.startsWith('//'), 'HEALTH_PATH_INVALID');
    const response = await healthFetch(new URL(path, appOrigin), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    invariant(response.ok, 'BUILD_IDENTITY_UNAVAILABLE');
    const value = await response.json() as any;
    invariant(value.build?.sha === (name === 'api' ? config.apiCommit : config.targetCommit) && value.build?.artifactId === config.builds[name] && Number.isFinite(Date.parse(value.build?.startedAt)), 'TARGET_BUILD_MISMATCH');
  }
}
export async function verifyApiBuild(config: Config, healthFetch: typeof fetch = fetch): Promise<void> {
  await verify(config, [['api', config.apiOrigin]], healthFetch);
}
export async function verifyBuilds(config: Config, healthFetch: typeof fetch = fetch): Promise<void> {
  await verify(config, [...Object.entries(config.origins), ['api', config.apiOrigin]], healthFetch);
}
