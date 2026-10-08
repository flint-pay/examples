import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ignored = new Set(['.git', '.context', 'node_modules', 'dist', 'coverage', 'test-results', 'playwright-report']);
const pathPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const allowedFields = new Set(['$schema', 'schema_version', 'kind', 'id', 'area', 'title', 'summary',
  'language', 'runtime', 'status', 'status_note', 'guides', 'covers', 'requires', 'commands', 'ports', 'env', 'ci']);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, field) {
  requireCondition(typeof value === 'string' && value.trim().length > 0 && !/[\r\n\u2013\u2014]/u.test(value),
    `${field} must be nonempty text on one line without em or en dashes.`);
}

function enumValue(value, choices, field) {
  requireCondition(choices.includes(value), `${field} has an unsupported value.`);
}

function strings(values, field, pattern) {
  requireCondition(Array.isArray(values) && values.every((value) => typeof value === 'string' &&
    (!pattern || pattern.test(value))) && new Set(values).size === values.length, `${field} must contain unique valid strings.`);
}

function checkStrings(value) {
  if (typeof value === 'string') requireCondition(!/[\u2013\u2014]/u.test(value), 'Manifest strings cannot contain em or en dashes.');
  else if (value && typeof value === 'object') Object.values(value).forEach(checkStrings);
}

function parseJson(source) {
  try { return JSON.parse(source); } catch { throw new Error('Invalid JSON.'); }
}

export function validateManifest(manifest, id, packageJson, environmentSource) {
  requireCondition(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Manifest must be an object.');
  requireCondition(Object.keys(manifest).every((key) => allowedFields.has(key)), 'Manifest has an unknown field.');
  checkStrings(manifest);
  requireCondition(manifest.schema_version === 1, 'schema_version must be 1.');
  requireCondition(pathPattern.test(id) && manifest.id === id, 'id must match the kebab-case example folder path.');
  requireCondition(manifest.area === id.split('/')[0], 'area must match the top-level folder.');
  enumValue(manifest.kind, ['example', 'e2e'], 'kind');
  enumValue(manifest.language, ['typescript'], 'language');
  text(manifest.title, 'title');
  text(manifest.summary, 'summary');
  requireCondition(manifest.runtime?.node === '>=24', 'runtime.node must be >=24.');
  enumValue(manifest.status, ['stable', 'beta'], 'status');
  if (manifest.status === 'beta') text(manifest.status_note, 'status_note');
  requireCondition(Array.isArray(manifest.guides) && manifest.guides.length > 0, 'guides must include a public guide.');
  for (const guide of manifest.guides) {
    text(guide.title, 'guide title');
    text(guide.url, 'guide URL');
    let url;
    try { url = new URL(guide.url); } catch { throw new Error('Guide URL is invalid.'); }
    requireCondition(url.protocol === 'https:' && url.hostname === 'developers.withflintpay.com' &&
      /^\/docs\/guides\/[a-z0-9/-]+$/.test(url.pathname) && (!url.hash || /^#[a-z0-9-]+$/.test(url.hash)) &&
      url.href === guide.url && !url.username && !url.password && !url.search && !url.port,
    'Guide URLs must point to public Flint guides over HTTPS.');
  }
  const needs = manifest.requires;
  requireCondition(needs && typeof needs === 'object', 'requires is required.');
  requireCondition(needs.flint_sdk?.package === '@flintpay/node' &&
    /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(needs.flint_sdk?.version ?? ''),
  'requires.flint_sdk must pin an exact published @flintpay/node version.');
  for (const field of ['stripe_js', 'second_sandbox']) requireCondition(typeof needs[field] === 'boolean', `requires.${field} must be boolean.`);
  requireCondition(needs.stripe_test_mode === true, 'Only Stripe test mode is supported.');
  enumValue(needs.sandbox, ['any', 'dedicated'], 'requires.sandbox');
  enumValue(needs.customer_account_mode, ['any', 'merchant_hosted', 'flint_hosted'], 'requires.customer_account_mode');
  for (const field of ['webhooks', 'inbox']) enumValue(needs[field], ['none', 'optional', 'required'], `requires.${field}`);
  for (const field of ['capabilities', 'sandbox_setup']) {
    requireCondition(Array.isArray(needs[field]), `requires.${field} must be an array.`);
    for (const requirement of needs[field]) {
      requireCondition(typeof requirement.required === 'boolean', `requires.${field}.required must be boolean.`);
      text(requirement[field === 'capabilities' ? 'name' : 'id'], `requires.${field} identifier`);
      if (field === 'sandbox_setup') text(requirement.how, 'sandbox setup instructions');
    }
  }
  const commands = manifest.commands;
  requireCondition(commands && typeof commands === 'object', 'commands is required.');
  for (const field of ['install', 'setup', 'dev', 'check', 'test']) text(commands[field], `commands.${field}`);
  requireCondition(commands.check === 'npm run check' && commands.test === 'npm test', 'Static commands must use npm run check and npm test.');
  requireCondition(Array.isArray(manifest.ports) && manifest.ports.length > 0 && manifest.ports.every((port) => Number.isInteger(port) && port > 0 && port < 65536) &&
    new Set(manifest.ports).size === manifest.ports.length, 'ports must contain unique TCP port numbers.');
  requireCondition(manifest.env?.file === '.env.example', 'env.file must be .env.example.');
  strings(manifest.env.required, 'env.required', /^[A-Z][A-Z0-9_]*$/);
  strings(manifest.env.optional, 'env.optional', /^[A-Z][A-Z0-9_]*$/);
  const names = [...manifest.env.required, ...manifest.env.optional];
  requireCondition(new Set(names).size === names.length, 'Required and optional environment names must not overlap.');
  const defined = new Set([...environmentSource.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]));
  requireCondition(names.every((name) => defined.has(name)), 'Every manifest environment name must exist in .env.example.');
  requireCondition(manifest.ci?.check === true, 'ci.check must be true.');
  for (const field of ['integration', 'browser', 'e2e']) {
    enumValue(manifest.ci[field], ['none', 'nightly'], `ci.${field}`);
    if (manifest.ci[field] === 'nightly') {
      const command = field === 'e2e' ? 'e2e' : `test_${field}`;
      const script = field === 'e2e' ? 'e2e' : `test:${field}`;
      requireCondition(commands[command] === `npm run ${script}` && typeof packageJson.scripts?.[script] === 'string',
        `Nightly ${field} requires the matching npm script and manifest command.`);
    }
  }
  if (manifest.kind === 'e2e') {
    strings(manifest.covers, 'covers', pathPattern);
    requireCondition(manifest.covers.length > 0, 'An e2e harness must cover examples.');
  } else requireCondition(manifest.covers === undefined, 'covers is only supported for kind e2e.');
  const sdk = packageJson.dependencies?.['@flintpay/node'] ?? packageJson.devDependencies?.['@flintpay/node'];
  requireCondition(sdk === needs.flint_sdk.version, 'The package SDK dependency must match the exact manifest pin.');
  for (const name of ['check', 'test']) requireCondition(typeof packageJson.scripts?.[name] === 'string', `Package script ${name} is required.`);
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  requireCondition(Object.values(dependencies).every((version) => typeof version === 'string' && !/^(?:workspace:|link:|file:)/.test(version)),
    'Example dependencies must not require a shared local package.');
  return manifest;
}

export function discoverExamples(root = process.cwd()) {
  const manifests = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.isDirectory() && !ignored.has(entry.name) && !entry.name.startsWith('.')) visit(join(directory, entry.name));
      else if (entry.isFile() && entry.name === 'example.json') {
        const folder = directory;
        const id = relative(root, folder).split('\\').join('/');
        try {
          for (const file of ['package.json', 'package-lock.json', '.env.example', 'README.md']) {
            requireCondition(statSync(join(folder, file)).isFile(), 'Every example must be self-contained.');
          }
          requireCondition(statSync(join(folder, 'tests')).isDirectory(), 'Every example needs a tests directory.');
          const manifest = parseJson(readFileSync(join(folder, 'example.json'), 'utf8'));
          manifests.push(validateManifest(manifest, id, parseJson(readFileSync(join(folder, 'package.json'), 'utf8')),
            readFileSync(join(folder, '.env.example'), 'utf8')));
        } catch (error) {
          // Metadata values and private environment values never enter diagnostics.
          throw new Error(`Manifest validation failed for ${pathPattern.test(id) ? id : 'an invalid folder'}: ${error.code ? 'A required file is missing.' : error.message}`);
        }
      }
    }
  }
  visit(resolve(root));
  requireCondition(manifests.length > 0, 'No example manifests were found.');
  const ids = new Set(manifests.filter((manifest) => manifest.kind === 'example').map((manifest) => manifest.id));
  for (const manifest of manifests.filter((item) => item.kind === 'e2e')) {
    requireCondition(manifest.covers.every((id) => ids.has(id)), 'An e2e harness references an unknown example.');
  }
  return manifests.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(`Validated ${discoverExamples().length} example manifests.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
