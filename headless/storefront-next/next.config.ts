import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A tab left open across a deploy reloads instead of calling server actions the new build doesn't have.
  deploymentId: process.env.BUILD_SHA || undefined,
  agentRules: false,
  reactStrictMode: true,
  // This folder is self-contained; don't treat the examples repository root as the workspace.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
