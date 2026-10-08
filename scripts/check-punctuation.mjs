import { fileURLToPath } from 'node:url';
import { readSnapshot } from './check-publication.mjs';

export function punctuationViolations(files) {
  return files.filter(({ bytes }) => !bytes.includes(0) && /[\u2013\u2014]/u.test(bytes.toString('utf8'))).length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const argument = process.argv[2] ?? '--head';
    if (!['--index', '--head'].includes(argument) || process.argv.length > 3) throw new Error('Use --index or --head.');
    const files = readSnapshot(process.cwd(), argument.slice(2));
    if (punctuationViolations(files)) throw new Error('Public text contains em or en dashes. Replace prose punctuation with commas or periods.');
    console.log('Public text punctuation checks passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
