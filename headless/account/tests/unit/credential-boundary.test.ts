import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const allowed = new Map<string, Set<string>>([
  ['app.ts', new Set(['customers.list', 'customers.create', 'customerVerifications.create', 'customerVerifications.confirm', 'customers.linkGuestPurchases', 'returnReasons.list', 'settings.getEffective', 'customers.revokeSessions', 'emailPreferenceLinks.lookup', 'emailPreferenceLinks.unsubscribe'])],
  ['flint/customer-sessions.ts', new Set(['customerSessions.create', 'customerSessions.revoke', 'customers.revokeSessions', 'customerDeletionRequests.list'])],
  ['flint/preflight.ts', new Set(['capabilities.listWithResponse', 'merchants.get', 'settings.get'])],
]);
function walk(node: ts.Node, visit: (node: ts.Node) => void): void { visit(node); ts.forEachChild(node, child => walk(child, visit)); }
function files(root: string): string[] { return readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(root, e.name)) : e.name.endsWith('.ts') ? [join(root, e.name)] : []); }
function startup(node: ts.Node): boolean { for (let p: ts.Node | undefined = node; p; p = p.parent) if (ts.isFunctionDeclaration(p) && p.name?.text === 'preflight') return true; return false; }
export function credentialViolations(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), failures: string[] = [];
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => name === file ? source : undefined;
  const program = ts.createProgram([file], { noLib: true, noResolve: true }, host), checker = program.getTypeChecker();
  const hasMerchant = (node: ts.Node, seen = new Set<ts.Symbol>()): boolean => {
    let found = false;
    walk(node, c => {
      if (ts.isCallExpression(c) && /(?:^|\.)auth\.merchant$/.test(c.expression.getText(source))) found = true;
      if (!ts.isIdentifier(c)) return;
      const symbol = checker.getSymbolAtLocation(c);
      if (!symbol || seen.has(symbol)) return;
      for (const declaration of symbol.declarations ?? []) if (ts.isVariableDeclaration(declaration) && declaration.initializer && !ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer) && hasMerchant(declaration.initializer, new Set([...seen, symbol]))) found = true;
    });
    return found;
  };
  walk(source, node => {
    if (ts.isPropertyAssignment(node) && file !== 'flint/auth.ts' && ['apiKey', 'customerToken', 'CheckoutSessionIDHeader', 'CheckoutSessionSecretHeader', 'X-Checkout-Session-ID', 'X-Checkout-Session-Secret'].includes(node.name.getText(source).replace(/^['"]|['"]$/g, ''))) failures.push('CREDENTIAL_BUILDER_OUTSIDE_AUTH');
    if (!ts.isCallExpression(node) || !node.arguments.some(arg => hasMerchant(arg))) return;
    const match = /(?:^|\.)client\.(\w+)\.(\w+)$/.exec(node.expression.getText(source));
    if (!match) return;
    const operation = `${match[1]}.${match[2]}`;
    if (!allowed.get(file)?.has(operation) || file === 'flint/preflight.ts' && !startup(node)) failures.push(`MERCHANT_OPERATION_FORBIDDEN:${operation}`);
  });
  return failures;
}
test('account merchant credentials stay on the module and operation allowlist', () => {
  const root = resolve('src');
  assert.deepEqual(files(root).flatMap(file => credentialViolations(readFileSync(file, 'utf8'), relative(root, file)).map(code => `${relative(root, file)}:${code}`)), []);
});
test('buyer reads and merchant configuration outside startup are refused', () => {
  for (const [file, text] of [
    ['app.ts', 'client.orders.get(id, undefined, auth.merchant())'],
    ['app.ts', 'client.me.get(undefined, auth.merchant())'],
    ['app.ts', 'const opts=auth.merchant(); client.invoices.get(id, undefined, opts)'],
    ['app.ts', 'client.settings.get(undefined, auth.merchant())'],
    ['flint/other.ts', 'client.customers.list({}, auth.merchant())'],
    ['flint/preflight.ts', 'function buyerHandler(){client.settings.get(undefined, auth.merchant())}'],
    ['app.ts', 'const options={customerToken:value}'],
  ]) assert.ok(credentialViolations(text, file).length, file);
  assert.deepEqual(credentialViolations('export async function preflight(){client.settings.get(undefined, auth.merchant())}', 'flint/preflight.ts'), []);
});
