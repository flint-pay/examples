import { writePrivate } from './private-files.ts';
import { invariant, requestId } from './safe.ts';

export type ScenarioStatus = 'NOT RUN' | 'PASS' | 'FAIL' | 'BLOCKED' | 'OUT OF SCOPE';
export type PrerequisiteStatus = 'PENDING' | 'FAIL' | 'BLOCKED' | 'RESOLVED';
export type Root = { id: string; status: PrerequisiteStatus; code: string; dependsOn?: string; authority?: string };
export type RowResult = { id: string; status: ScenarioStatus; prerequisite?: string; evidence: string[]; requestIds: string[] };
export class Results {
  roots = new Map<string, Root>();
  rows = new Map<string, RowResult>();
  readonly file: string;
  constructor(file: string, ids: string[]) {
    this.file = file;
    for (const id of ids) { invariant(!this.rows.has(id), 'DUPLICATE_SCENARIO'); this.rows.set(id, { id, status: 'NOT RUN', evidence: [], requestIds: [] }); }
  }
  root(root: Root): void {
    const prior = this.roots.get(root.id);
    invariant(!prior || JSON.stringify(prior) === JSON.stringify(root), 'PREREQUISITE_RECORDED_TWICE');
    this.roots.set(root.id, root);
  }
  updateRoot(root: Root): void {
    invariant(/^PRQ-[A-Z0-9_-]+$/.test(root.id) && /^[A-Z][A-Z0-9_-]{1,100}$/.test(root.code), 'UNSAFE_PREREQUISITE');
    // One prerequisite row changes status as new real evidence becomes available.
    this.roots.set(root.id, root);
  }
  finish(id: string, status: ScenarioStatus, evidence: string[], prerequisite?: string, ids: unknown[] = []): void {
    invariant(this.rows.has(id), 'UNKNOWN_SCENARIO');
    invariant(evidence.every(x => /^[A-Z0-9_:-]{1,120}$/.test(x)), 'UNSAFE_EVIDENCE');
    invariant(status !== 'PASS' || evidence.length > 0, 'PASS_REQUIRES_EVIDENCE');
    invariant(status !== 'OUT OF SCOPE', 'USER_EXCEPTION_REQUIRED');
    this.rows.set(id, { id, status, prerequisite, evidence, requestIds: ids.map(requestId).filter((x): x is string => !!x) });
  }
  stopped(id: string, prerequisite: string): void {
    invariant(this.roots.has(prerequisite) && this.roots.get(prerequisite)!.status !== 'RESOLVED', 'STOP_ROOT_REQUIRED');
    // Root blockers are reported once. Their unattempted dependents are NOT RUN.
    this.finish(id, 'NOT RUN', ['PREREQUISITE_UNRESOLVED'], prerequisite);
  }
  exception(id: string, authority: { acceptedByUser: true; reference: string }): void {
    invariant(this.rows.has(id) && authority.acceptedByUser === true && /^[A-Z0-9_-]{3,100}$/.test(authority.reference), 'USER_EXCEPTION_REQUIRED');
    this.rows.set(id, { id, status: 'OUT OF SCOPE', evidence: [`USER_EXCEPTION:${authority.reference}`], requestIds: [] });
  }
  async save(): Promise<void> {
    await writePrivate(this.file, { schema_version: 1, evidence_class: 'real_acceptance', scenarios: [...this.rows.values()], prerequisites: [...this.roots.values()], complete: [...this.rows.values()].every(x => x.status === 'PASS' || x.status === 'OUT OF SCOPE') && ![...this.roots.values()].some(r => r.status === 'FAIL') });
  }
}
