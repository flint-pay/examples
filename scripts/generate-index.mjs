import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { discoverExamples } from './validate-manifests.mjs';

const start = '<!-- examples:index:start -->';
const end = '<!-- examples:index:end -->';
const escapeText = (value) => value.replace(/[\\|\[\]`]/g, '\\$&').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function renderIndex(manifests) {
  manifests = [...manifests].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const table = (items) => [
    '| Example | What it shows | Guides | Run | Status |',
    '| --- | --- | --- | --- | --- |',
    ...items.map((manifest) => {
      const guides = manifest.guides.map((guide) => `[${escapeText(guide.title)}](${guide.url})`).join('<br>');
      const command = manifest.kind === 'e2e' ? `cd ${manifest.id} && npm ci && npm run e2e` :
        `cd ${manifest.id} && npm ci && npm run dev`;
      return `| [${escapeText(manifest.title)}](${manifest.id}/) | ${escapeText(manifest.summary)} | ${guides} | \`${command}\` | ${escapeText(manifest.status)} |`;
    }),
  ].join('\n');
  const examples = manifests.filter((manifest) => manifest.kind === 'example');
  const acceptance = manifests.filter((manifest) => manifest.kind === 'e2e');
  return `${start}\n\n${table(examples)}${acceptance.length ? `\n\n### Acceptance\n\n${table(acceptance)}` : ''}\n\n${end}`;
}

export function updateIndex(source, manifests) {
  const first = source.indexOf(start);
  const last = source.indexOf(end);
  if (first === -1 || last < first || source.indexOf(start, first + start.length) !== -1 ||
    source.indexOf(end, last + end.length) !== -1) throw new Error('README.md needs one ordered pair of example index markers.');
  return source.slice(0, first) + renderIndex(manifests) + source.slice(last + end.length);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Use --check or no arguments.');
    const source = readFileSync('README.md', 'utf8');
    const generated = updateIndex(source, discoverExamples());
    if (process.argv[2] === '--check') {
      if (source !== generated) throw new Error('README index is stale. Run node scripts/generate-index.mjs.');
      console.log('README index is current.');
    } else { writeFileSync('README.md', generated); console.log('README index generated.'); }
  } catch (error) { console.error(error.code ? 'README.md is required before generating the index.' : error.message); process.exitCode = 1; }
}
