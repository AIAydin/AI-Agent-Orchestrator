import { describe, expect, it } from 'vitest';

import { NODE_NAME_POOL, assignNodeName, ensureUniqueNodeName } from './node-names.js';

describe('NODE_NAME_POOL', () => {
  it('has no duplicate names, case-insensitively', () => {
    const seen = new Set<string>();
    for (const name of NODE_NAME_POOL) {
      const key = name.trim().toLowerCase();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(NODE_NAME_POOL.length).toBeGreaterThanOrEqual(50);
  });

  it('contains only non-empty, trimmed names', () => {
    for (const name of NODE_NAME_POOL) {
      expect(name.trim()).toBe(name);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('avoids names that collide with well-known tools', () => {
    expect(NODE_NAME_POOL).not.toContain('Hermes');
  });
});

describe('assignNodeName', () => {
  it('picks the first pool name when nothing is in use', () => {
    expect(assignNodeName(new Set())).toBe(NODE_NAME_POOL[0]);
  });

  it('skips names already in use, case-insensitively and trimmed', () => {
    const inUse = new Set([NODE_NAME_POOL[0]!.toUpperCase(), ` ${NODE_NAME_POOL[1]} `]);
    expect(assignNodeName(inUse)).toBe(NODE_NAME_POOL[2]);
  });

  it('suffixes past pool exhaustion with the first free "<name> N" (N>=2)', () => {
    const inUse = new Set(NODE_NAME_POOL.map((name) => name.toLowerCase()));
    const assigned = assignNodeName(inUse);
    expect(assigned).toBe(`${NODE_NAME_POOL[0]} 2`);
  });

  it('continues past exhaustion to the next free numeric suffix', () => {
    const inUse = new Set([
      ...NODE_NAME_POOL.map((name) => name.toLowerCase()),
      `${NODE_NAME_POOL[0]!.toLowerCase()} 2`,
    ]);
    expect(assignNodeName(inUse)).toBe(`${NODE_NAME_POOL[0]} 3`);
  });

  it('is deterministic given the same in-use set', () => {
    const inUse = new Set([NODE_NAME_POOL[0]!]);
    expect(assignNodeName(inUse)).toBe(assignNodeName(new Set(inUse)));
  });
});

describe('ensureUniqueNodeName', () => {
  it('returns the desired name when it is free', () => {
    expect(ensureUniqueNodeName('Custom Name', new Set())).toBe('Custom Name');
  });

  it('suffixes on collision with the smallest available N>=2', () => {
    const inUse = new Set(['Alice']);
    expect(ensureUniqueNodeName('Alice', inUse)).toBe('Alice 2');
  });

  it('keeps incrementing the suffix until a free slot is found', () => {
    const inUse = new Set(['Alice', 'Alice 2', 'Alice 3']);
    expect(ensureUniqueNodeName('Alice', inUse)).toBe('Alice 4');
  });

  it('matches case-insensitively and trimmed, like peer-graph name resolution', () => {
    const inUse = new Set(['alice']);
    expect(ensureUniqueNodeName('  Alice  ', inUse)).toBe('Alice 2');
    expect(ensureUniqueNodeName('ALICE', inUse)).toBe('ALICE 2');
  });

  it('falls back to assignNodeName for empty or whitespace-only input', () => {
    expect(ensureUniqueNodeName('', new Set())).toBe(NODE_NAME_POOL[0]);
    expect(ensureUniqueNodeName('   ', new Set())).toBe(NODE_NAME_POOL[0]);
  });

  it('trims the desired name before using it when free', () => {
    expect(ensureUniqueNodeName('  Custom  ', new Set())).toBe('Custom');
  });
});
