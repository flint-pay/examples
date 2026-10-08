import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { parseDocument } from 'htmlparser2';
import { findAll, textContent } from 'domutils';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readPrivate, writePrivate } from './private-files.ts';
import { invariant, emit } from './safe.ts';
import { auditEmail, CHECKOUT_ORIGIN } from './email-links.ts';
import { API_ORIGIN } from './config.ts';
import type { Config } from './config.ts';

export type Mail = { subject: string; from: string; receivedAt: string; text: string; html: string; links: { text: string; href: string }[]; codes: string[] };
export type WaitMail = { to: string; after: Date; subjectIncludes?: string; timeoutMs?: number };
export type Inbox = { waitForEmail(query: WaitMail): Promise<Mail>; close(): Promise<void> };
export function parseLinks(html: string, text: string): Mail['links'] {
  const dom = parseDocument(html);
  const links = findAll(n => n.type === 'tag' && n.name === 'a' && !!n.attribs.href, dom.children).map(n => ({ text: textContent(n), href: n.attribs.href }));
  for (const href of text.match(/https?:\/\/[^\s<>"']+/g) ?? []) if (!links.some(l => l.href === href)) links.push({ text: '', href });
  return links;
}
export function auditLinks(mail: Mail, origins: string[], family = 'order_receipts'): void {
  auditEmail(mail, family, { appOrigins: origins, apiOrigin: API_ORIGIN, checkoutOrigin: CHECKOUT_ORIGIN });
}
export function createInbox(config: Config, env: NodeJS.ProcessEnv = process.env): Inbox | undefined {
  if (config.inbox === 'operator') return new OperatorInbox(config.privateDir);
  if (config.inbox !== 'imap') return undefined;
  invariant(env.E2E_IMAP_HOST && env.E2E_IMAP_USER && env.E2E_IMAP_PASSWORD, 'IMAP_CONFIGURATION_PENDING');
  invariant((env.E2E_IMAP_PORT ?? '993') === '993', 'IMAP_TLS_REQUIRED');
  return new ImapInbox({ host: env.E2E_IMAP_HOST, port: 993, secure: true, auth: { user: env.E2E_IMAP_USER, pass: env.E2E_IMAP_PASSWORD }, logger: false, tls: { rejectUnauthorized: true } });
}
export class ImapInbox implements Inbox {
  client: ImapFlow;
  connected = false;
  constructor(options: ConstructorParameters<typeof ImapFlow>[0]) { this.client = new ImapFlow(options); }
  async waitForEmail(query: WaitMail): Promise<Mail> {
    if (!this.connected) { await this.client.connect(); this.connected = true; }
    const end = Date.now() + (query.timeoutMs ?? 180_000);
    while (Date.now() < end) {
      const lock = await this.client.getMailboxLock('INBOX');
      try {
        const uids = await this.client.search({ to: query.to, since: query.after }, { uid: true });
        for (const uid of (uids || []).slice().reverse()) {
          const msg = await this.client.fetchOne(uid, { source: true, internalDate: true }, { uid: true });
          if (!msg || !msg.source || !msg.internalDate || new Date(msg.internalDate).getTime() < query.after.getTime()) continue;
          const parsed = await simpleParser(msg.source);
          const to = Array.isArray(parsed.to) ? parsed.to.flatMap(t => t.value) : parsed.to?.value ?? [];
          if (!to.some(t => t.address?.toLowerCase() === query.to.toLowerCase())) continue;
          if (query.subjectIncludes && !parsed.subject?.includes(query.subjectIncludes)) continue;
          const text = parsed.text ?? '', html = typeof parsed.html === 'string' ? parsed.html : '';
          return { subject: parsed.subject ?? '', from: parsed.from?.text ?? '', receivedAt: new Date(msg.internalDate).toISOString(), text, html, links: parseLinks(html, text), codes: [...new Set(text.match(/\b\d{6}\b/g) ?? [])] };
        }
      } finally { lock.release(); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    invariant(false, 'INBOX_EMAIL_NOT_RECEIVED');
  }
  async close(): Promise<void> { if (this.connected) { await this.client.logout(); this.connected = false; } }
}
export class OperatorInbox implements Inbox {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async waitForEmail(query: WaitMail): Promise<Mail> {
    const nonce = randomBytes(16).toString('hex');
    await writePrivate(join(this.directory, 'inbox-request.json'), { nonce, to: query.to, after: query.after.toISOString(), subjectIncludes: query.subjectIncludes, instruction: 'Use the actual designated inbox. Supply receivedAt, subject, from, text and html, or observed codes and links. Keep this response private.' });
    emit({ event: 'INBOX_OPERATOR_INPUT_REQUIRED' });
    const end = Date.now() + (query.timeoutMs ?? 180_000);
    while (Date.now() < end) {
      try {
        const input = await readPrivate<Mail & { nonce: string; to: string }>(join(this.directory, 'inbox-response.json'));
        if (input.nonce === nonce) {
          invariant(input.to === query.to && Date.parse(input.receivedAt) >= query.after.getTime(), 'OPERATOR_EMAIL_MISMATCH');
          invariant(!query.subjectIncludes || input.subject.includes(query.subjectIncludes), 'OPERATOR_SUBJECT_MISMATCH');
          invariant(input.codes.every(c => /^\d{6}$/.test(c)), 'OPERATOR_CODE_INVALID');
          return { subject: input.subject, from: input.from, receivedAt: input.receivedAt, text: input.text ?? '', html: input.html ?? '', links: input.links ?? [], codes: input.codes ?? [] };
        }
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    invariant(false, 'INBOX_OPERATOR_TIMEOUT');
  }
  async close(): Promise<void> {}
}
