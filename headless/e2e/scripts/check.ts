import ts from 'typescript';
import { VAULT_QUERIES } from '../support/app-vault.ts';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from '../support/config.ts';
import { invariant, emit, safeFailure } from '../support/safe.ts';
import { validateRegistry, rows } from '../scenarios/registry.ts';

async function main() {
  validateRegistry();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  invariant(pkg.dependencies['@flintpay/node'] === SDK_VERSION && lock.packages['node_modules/@flintpay/node'].version === SDK_VERSION, 'SDK_EXACT_PIN_REQUIRED');
  const sources: { path: string; text: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.runs'].includes(item.name) || item.name.startsWith('.env') && item.name !== '.env.example') continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (/\.(ts|json|md)$/.test(path)) {
        const text = await readFile(path, 'utf8'); if (path.endsWith('.ts') && !path.includes('/tests/')) sources.push({path, text}); invariant(!/[\u2013\u2014]/.test(text), 'PUNCTUATION_CONTRACT');
        if (path !== fileURLToPath(import.meta.url)) invariant(!/recordVideo|recordHar|tracing\.start|\.screenshot\(|storageState\(/.test(text), 'RAW_BROWSER_ARTIFACTS_FORBIDDEN');
      }
    }
  };
  await walk(root); validateVaultSources(sources); emit({ event: 'HARNESS_STATIC_CHECK_PASS', count: rows.length });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { emit({ event: 'HARNESS_STATIC_CHECK_FAIL', code: safeFailure(e) }); process.exitCode = 1; });


function visit(node: ts.Node, fn: (node: ts.Node) => void): void { fn(node); ts.forEachChild(node, n => visit(n, fn)); }
export function validateVaultSources(sources: { path: string; text: string }[]): void {
  const expected = [
    "SELECT v.customer_session_id, v.secret, v.refresh_token, v.expires_at, v.refresh_expires_at FROM customer_session_vault v JOIN users u ON u.user_id = v.user_id WHERE u.email = ? AND u.flint_customer_id = ? AND u.flint_sandbox_id = ? AND v.sandbox_id = ? AND u.status = 'active'",
    "SELECT v.customer_session_id, v.expires_at, v.refresh_expires_at FROM customer_session_vault v JOIN users u ON u.user_id = v.user_id WHERE u.email = ? AND u.flint_customer_id = ? AND u.flint_sandbox_id = ? AND v.sandbox_id = ? AND u.status = 'active'",
    'SELECT COUNT(*) AS n FROM customer_session_vault v JOIN users u ON u.user_id = v.user_id WHERE u.email = ? AND v.sandbox_id = ?',
    'SELECT COUNT(*) AS n FROM sessions s JOIN users u ON u.user_id = s.user_id WHERE u.email = ?',
    'SELECT COUNT(*) AS n FROM account_pending_revocations WHERE customer_session_id = ?',
  ];
  invariant(JSON.stringify(Object.values(VAULT_QUERIES)) === JSON.stringify(expected), 'APP_VAULT_QUERY_FORBIDDEN');
  for (const {path, text} of sources) {
    if (path === fileURLToPath(import.meta.url)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const tainted = new Set<string>();
    const containsAuthority = (node: ts.Node): boolean => {
      if (ts.isPropertyAccessExpression(node) && ['familyId', 'expiresAt', 'refreshExpiresAt', 'mintedAt'].includes(node.name.text)) return false;
      if (ts.isIdentifier(node) && tainted.has(node.text)) return true;
      if (ts.isPropertyAccessExpression(node) && ['secret', 'refreshToken'].includes(node.name.text) && containsAuthority(node.expression)) return true;
      return node.getChildren(source).some(containsAuthority);
    };
    visit(source, n => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) invariant(n.moduleSpecifier.text !== 'node:sqlite' || path.endsWith('/support/app-vault.ts'), 'APP_VAULT_SQLITE_BOUNDARY');
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) invariant(!/\b(?:environ|identity_actions|password_hash|csrf_token|session_hash)\b/.test(n.text), 'APP_VAULT_FORBIDDEN_REFERENCE');
      if (ts.isParameter(n) && n.type?.getText(source) === 'SealedCredential' && ts.isIdentifier(n.name)) tainted.add(n.name.text);
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && /\.readVault\(\)$/.test(n.initializer.getText(source).replace(/^await /, ''))) tainted.add(n.name.text);
    });
    let changed = true;
    while (changed) { changed = false; visit(source, n => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'use' && containsAuthority(n.expression.expression)) for (const arg of n.arguments) if (ts.isArrowFunction(arg)) for (const param of arg.parameters) if (ts.isIdentifier(param.name) && !tainted.has(param.name.text)) { tainted.add(param.name.text); changed = true; }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && containsAuthority(n.initializer) && !tainted.has(n.name.text)) { tainted.add(n.name.text); changed = true; } }); }
    visit(source, n => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^(?:d|driver|results|ledger)\./.test(n.left.getText(source))) invariant(!containsAuthority(n.right), 'SEALED_CREDENTIAL_SINK_FORBIDDEN');
      if (!ts.isCallExpression(n)) return;
      const callee = n.expression.getText(source);
      if (/\.evaluate$|\.request\.|\bresults\.|(?:^|\.)ledger\.(?:record|track|action)$|(?:^|\.)emit$|\.created\.set$|console\.|process\.(?:stdout|stderr)\.write|JSON\.stringify/.test(callee)) {
        const args = callee.endsWith('ledger.action') ? [n.arguments[3]].filter(Boolean) : n.arguments;
        invariant(!args.some(containsAuthority), 'SEALED_CREDENTIAL_SINK_FORBIDDEN');
      }
      if (path.endsWith('/support/app-vault.ts') && callee.endsWith('.prepare')) invariant(n.arguments.length === 1 && n.arguments[0].getText(source) === 'VAULT_QUERIES[kind]', 'APP_VAULT_QUERY_FORBIDDEN');
    });
    if (path.endsWith('/scenarios/account.ts')) {
      const refresh = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'appRefreshAcceptance');
      invariant(refresh && /Date\.now\(\)/.test(refresh.getText(source)) && /setTimeout\(/.test(refresh.getText(source)) && !/config\.[A-Za-z]*(?:now|sleep|clock|delay)/i.test(refresh.getText(source)), 'APP_SESSION_REAL_TIMER_REQUIRED');
    }
  }
}
