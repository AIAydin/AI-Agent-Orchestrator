import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalSessionView } from '../../../shared/terminal/index.js';
import { migrate } from '../database.js';
import {
  createTerminalSession,
  getTerminalSession,
  recoverInterruptedTerminalSessions,
  terminalSessionIntegrityMessages,
  updateTerminalSession,
} from './repository.js';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SESSION_ID = '20000000-0000-4000-8000-000000000001';
const NOW = '2026-07-17T16:00:00.000Z';

describe('terminal session repository', () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('persists only path-free metadata while retaining lifecycle and transcript cursors', () => {
    const database = fixtureDatabase();
    databases.push(database);
    const exact = session({
      executable: '/private/tools/zsh',
      arguments: ['-lc', 'token=must-not-persist'],
      status: 'running',
      startedAt: NOW,
    });

    createTerminalSession(database, exact);
    updateTerminalSession(
      database,
      { ...exact, nextSequence: 2, updatedAt: '2026-07-17T16:00:01.000Z' },
      { transcriptBytes: 128, lastPersistedSequence: 1 },
    );

    expect(getTerminalSession(database, SESSION_ID)).toMatchObject({
      executable: 'zsh',
      arguments: [],
      nextSequence: 2,
    });
    const stored = database
      .prepare('SELECT value_json FROM terminal_sessions WHERE id = ?')
      .get(SESSION_ID) as { value_json: string };
    expect(stored.value_json).not.toContain('/private/tools');
    expect(stored.value_json).not.toContain('must-not-persist');
    expect(stored.value_json).toContain('"transcriptBytes":128');
    expect(terminalSessionIntegrityMessages(database)).toEqual([]);
  });

  it('recovers both starting and running records as honest lost sessions', () => {
    const database = fixtureDatabase();
    databases.push(database);
    createTerminalSession(database, session());
    createTerminalSession(
      database,
      session({
        id: '30000000-0000-4000-8000-000000000001',
        nodeId: 'terminal-running',
        status: 'running',
        startedAt: NOW,
      }),
    );

    const report = recoverInterruptedTerminalSessions(
      database,
      new Date('2026-07-17T17:00:00.000Z'),
    );

    expect(report.lostSessionIds).toEqual([SESSION_ID, '30000000-0000-4000-8000-000000000001']);
    expect(getTerminalSession(database, SESSION_ID)).toMatchObject({
      status: 'lost',
      startedAt: NOW,
      endedAt: '2026-07-17T17:00:00.000Z',
    });
    expect(terminalSessionIntegrityMessages(database)).toEqual([]);
  });

  function fixtureDatabase(): DatabaseSync {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON;');
    migrate(database);
    database
      .prepare(
        `INSERT INTO recent_projects(id, path, value_json, opened_at)
         VALUES(?, ?, '{}', ?)`,
      )
      .run(PROJECT_ID, '/private/project', NOW);
    return database;
  }
});

function session(overrides: Partial<TerminalSessionView> = {}): TerminalSessionView {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    nodeId: 'terminal-1',
    executable: '/bin/zsh',
    arguments: ['-l'],
    cwdRelative: '.',
    environmentVariableNames: ['PATH'],
    columns: 100,
    rows: 30,
    permission: {
      label: 'Local terminal (not sandboxed)',
      sandboxed: false,
      filesystem: 'operating-system-user',
      network: 'operating-system-user',
      detail: 'This terminal is not a security sandbox.',
    },
    status: 'starting',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    earliestSequence: 1,
    nextSequence: 1,
    outputTruncated: false,
    updatedAt: NOW,
    ...overrides,
  };
}
