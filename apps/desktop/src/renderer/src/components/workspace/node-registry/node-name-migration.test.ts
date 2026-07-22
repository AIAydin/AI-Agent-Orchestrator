import { describe, expect, it } from 'vitest';

import { migrateGenericNodeTitles, type MigratableNode } from './node-name-migration.js';
import { NODE_NAME_POOL } from './node-names.js';

describe('migrateGenericNodeTitles', () => {
  it('assigns distinct friendly names to nodes with empty or generic-kind-label titles', () => {
    const nodes: MigratableNode[] = [
      node('a', 'terminal', 'Terminal'),
      node('b', 'terminal', 'Terminal'),
      node('c', 'task', ''),
    ];
    const migrated = migrateGenericNodeTitles(nodes);
    const titles = migrated.map((n) => n.data.title);
    expect(new Set(titles).size).toBe(3);
    for (const title of titles) expect(NODE_NAME_POOL).toContain(title);
  });

  it('treats an agent title equal to its provider theme label as generic', () => {
    const nodes: MigratableNode[] = [node('a', 'agent', 'Claude Code', 'claude')];
    const migrated = migrateGenericNodeTitles(nodes);
    expect(migrated[0]?.data.title).not.toBe('Claude Code');
    expect(NODE_NAME_POOL).toContain(migrated[0]?.data.title);
  });

  it('treats a bare "Agent" title as generic regardless of adapter', () => {
    const nodes: MigratableNode[] = [node('a', 'agent', 'Agent')];
    const migrated = migrateGenericNodeTitles(nodes);
    expect(migrated[0]?.data.title).not.toBe('Agent');
  });

  it('leaves a user-customized title untouched', () => {
    const nodes: MigratableNode[] = [node('a', 'terminal', 'My build shell')];
    const migrated = migrateGenericNodeTitles(nodes);
    expect(migrated[0]?.data.title).toBe('My build shell');
    expect(migrated[0]).toBe(nodes[0]);
  });

  it('does not collide a newly assigned name with an existing custom title', () => {
    const nodes: MigratableNode[] = [
      node('a', 'terminal', 'Terminal'),
      node('b', 'terminal', NODE_NAME_POOL[0]!),
    ];
    const migrated = migrateGenericNodeTitles(nodes);
    expect(migrated[0]?.data.title).not.toBe(NODE_NAME_POOL[0]);
    expect(migrated[1]?.data.title).toBe(NODE_NAME_POOL[0]);
  });

  it('is idempotent: a second pass over already-migrated nodes is a no-op', () => {
    const nodes: MigratableNode[] = [
      node('a', 'terminal', 'Terminal'),
      node('b', 'agent', 'Agent'),
    ];
    const once = migrateGenericNodeTitles(nodes);
    const twice = migrateGenericNodeTitles(once);
    expect(twice).toBe(once);
    expect(twice.map((n) => n.data.title)).toEqual(once.map((n) => n.data.title));
  });

  it('returns the same array reference when nothing needs migrating', () => {
    const nodes: MigratableNode[] = [node('a', 'terminal', 'Custom title')];
    expect(migrateGenericNodeTitles(nodes)).toBe(nodes);
  });
});

function node(id: string, kind: string, title: string, adapterId?: string): MigratableNode {
  return { id, data: { kind: kind as MigratableNode['data']['kind'], title, adapterId } };
}
