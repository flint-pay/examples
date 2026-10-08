import { performance } from 'node:perf_hooks';

export type Build = { sha: string; artifactId: string; startedAt: string };
export function readBuild(env: NodeJS.ProcessEnv): Build | undefined {
  const sha = env.BUILD_SHA, artifactId = env.BUILD_ARTIFACT_ID;
  if (sha === undefined && artifactId === undefined) return undefined;
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(artifactId ?? '')) throw new Error('Invalid build identity configuration');
  return { sha: sha!, artifactId: artifactId!, startedAt: new Date(performance.timeOrigin).toISOString() };
}
