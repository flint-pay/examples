import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverExamples } from './validate-manifests.mjs';

export function matrices(manifests) {
  const row = ({ id, kind, ports }) => ({ id, kind, port: ports[0] });
  return {
    static: { include: manifests.filter((manifest) => manifest.ci.check).map(row) },
    integration: { include: manifests.filter((manifest) => manifest.ci.integration === 'nightly').map(row) },
    browser: { include: manifests.filter((manifest) => manifest.ci.browser === 'nightly').map(row) },
    e2e: { include: manifests.filter((manifest) => manifest.ci.e2e === 'nightly').map(row) },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = matrices(discoverExamples());
    if (process.argv[2] === '--github-output' && process.env.GITHUB_OUTPUT) {
      for (const [name, matrix] of Object.entries(result)) {
        appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${JSON.stringify(matrix)}\nhas-${name}=${matrix.include.length > 0}\n`);
      }
    } else if (process.argv.length === 2) console.log(JSON.stringify(result));
    else throw new Error('Use --github-output in GitHub Actions, or no arguments for JSON output.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
