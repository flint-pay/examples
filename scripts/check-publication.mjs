import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const maximumFileBytes = 4 * 1024 * 1024;

export function checkPublicFile(path, bytes, mode = '100644') {
  const problems = [];
  const parts = path.toLowerCase().split('/');
  const leaf = parts.at(-1);
  if (!['100644', '100755'].includes(mode)) problems.push('non-regular Git entry');
  if (path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) problems.push('unsafe path');
  if (parts.some((part) => [
    '.context', '.git', '.auth', '.cache', '.aws', '.ssh', 'node_modules', 'dist', 'coverage', 'playwright-report',
    'test-results', 'blob-report', 'screenshots', 'traces', 'logs', 'reports', 'data',
  ].includes(part))) problems.push('private or generated artifact');
  if (leaf === '.ds_store' || (leaf.startsWith('.env') && leaf !== '.env.example') ||
    /\.(?:pem|key|p12|pfx|har|log|zip|gz|tgz|tar|trace|sqlite(?:-wal|-shm|-journal)?|db(?:-wal|-shm|-journal)?)$/i.test(leaf) ||
    /^(?:id_rsa|id_ed25519|credentials|storage[-_]?state)(?:[-_.]|$)/i.test(leaf) ||
    (/^(?:trace|screenshot|results?|reports?)(?:[-_.]|$)/i.test(leaf) && !leaf.endsWith('.ts'))) {
    problems.push('credential or captured artifact');
  }
  if (bytes.length > maximumFileBytes) problems.push('file exceeds publication size limit');
  if (problems.length) return [...new Set(problems)];
  const content = bytes.toString('utf8');
  if (/\b(?:ord|cus|customer|mer|merchant|org|env|prod|price|pi|pm|cs|inv|sub|ret|sandbox)_[a-z0-9]{16,}\b/i.test(content) ||
    /\b[a-z][a-z0-9_]{1,24}_[0-9a-hjkmnp-tv-z]{26}\b/i.test(content) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(content)) {
    problems.push('fixture identifier');
  }
  if (/\bflint_(?:test|live)_[a-z0-9]{12,}\b/i.test(content)) problems.push('Flint credential');
  for (const match of content.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    if (!/(?:^|\.)(?:example\.(?:com|org|net)|invalid|test)$/i.test(match[1])) {
      problems.push('personal email address');
      break;
    }
  }
  for (const match of content.matchAll(/(?:^|[^\w])(\+[1-9][0-9]{9,14})\b/g)) {
    if (!/^\+1[2-9][0-9]{2}55501[0-9]{2}$/.test(match[1])) {
      problems.push('personal phone number');
      break;
    }
  }
  return [...new Set(problems)];
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot read the selected Git snapshot.');
  return result.stdout;
}

export function readSnapshot(root, source = 'index') {
  if (!['index', 'head'].includes(source)) throw new Error('Snapshot must be index or head.');
  const entries = git(root, source === 'index' ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', 'HEAD'])
    .toString('utf8').split('\0').filter(Boolean);
  return entries.map((entry) => {
    const tab = entry.indexOf('\t');
    const fields = entry.slice(0, tab).split(' ');
    const [mode] = fields;
    const object = fields[source === 'index' ? 1 : 2];
    if (source === 'index' && fields[2] !== '0') throw new Error('Resolve index conflicts before publication.');
    const path = entry.slice(tab + 1);
    const pathProblems = checkPublicFile(path, Buffer.alloc(0), mode);
    if (pathProblems.length) throw new Error(`Publication blocked: ${pathProblems.join(', ')}.`);
    return { path, mode, bytes: git(root, ['cat-file', 'blob', object]) };
  });
}

export function checkPublication(root, source = 'index') {
  const files = readSnapshot(root, source);
  if (!files.length) throw new Error('No public files exist in the selected Git snapshot.');
  const failures = files.flatMap(({ path, bytes, mode }) => checkPublicFile(path, bytes, mode));
  // Neither file names nor matched text are printed because either can contain private values.
  if (failures.length) throw new Error(`Publication blocked: ${[...new Set(failures)].join(', ')}.`);
  const snapshot = mkdtempSync(join(tmpdir(), 'flint-publication-'));
  try {
    const tree = join(snapshot, 'source');
    mkdirSync(tree);
    for (const { path, bytes } of files) {
      const destination = join(tree, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode: 0o600 });
    }
    // A trusted configuration and empty ignore file prevent repository suppressions.
    const config = join(snapshot, 'scanner.toml');
    const ignore = join(snapshot, 'scanner.ignore');
    writeFileSync(config, '[extend]\nuseDefault = true\n');
    writeFileSync(ignore, '');
    const result = spawnSync('mise', ['exec', 'gitleaks@8.30.1', '--', 'gitleaks', 'dir', tree,
      '--config', config, '--gitleaks-ignore-path', ignore, '--ignore-gitleaks-allow',
      '--redact=100', '--no-banner', '--no-color', '--max-decode-depth', '5'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, env: {
      ...process.env, GITLEAKS_CONFIG: '', GITLEAKS_CONFIG_TOML: '',
    } });
    if (result.status !== 0) throw new Error('Publication blocked: Gitleaks failed or detected a secret. Scanner output withheld.');
    return files.length;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const argument = process.argv[2] ?? '--index';
    if (!['--index', '--head'].includes(argument) || process.argv.length > 3) throw new Error('Use --index or --head.');
    const count = checkPublication(process.cwd(), argument.slice(2));
    console.log(`Publication checks passed for ${count} files from the ${argument.slice(2)} snapshot.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
