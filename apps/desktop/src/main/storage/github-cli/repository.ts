import type { DatabaseSync } from 'node:sqlite';

import { StoredGitHubCliBindingSchema, type StoredGitHubCliBinding } from './contracts.js';

interface GitHubCliBindingRow {
  readonly singleton: number;
  readonly value_json: string;
}

export function getGitHubCliBinding(database: DatabaseSync): StoredGitHubCliBinding | undefined {
  const row = database
    .prepare('SELECT singleton, value_json FROM github_cli_executable_binding WHERE singleton = 1')
    .get() as GitHubCliBindingRow | undefined;
  return row === undefined ? undefined : parseBindingRow(row);
}

export function saveGitHubCliBinding(
  database: DatabaseSync,
  binding: StoredGitHubCliBinding,
): StoredGitHubCliBinding {
  const parsed = StoredGitHubCliBindingSchema.parse(binding);
  database
    .prepare(
      `INSERT INTO github_cli_executable_binding(singleton, value_json) VALUES(1, ?)
       ON CONFLICT(singleton) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(JSON.stringify(parsed));
  return parsed;
}

export function clearGitHubCliBinding(database: DatabaseSync): boolean {
  return (
    Number(
      database.prepare('DELETE FROM github_cli_executable_binding WHERE singleton = 1').run()
        .changes,
    ) > 0
  );
}

export function gitHubCliBindingIntegrityMessages(database: DatabaseSync): string[] {
  const rows = database
    .prepare('SELECT singleton, value_json FROM github_cli_executable_binding ORDER BY singleton')
    .all() as unknown as GitHubCliBindingRow[];
  const messages: string[] = [];
  rows.forEach((row, index) => {
    try {
      parseBindingRow(row);
    } catch (error) {
      messages.push(
        `github_cli_executable_binding row ${index + 1}: ${error instanceof Error ? error.message : 'invalid binding'}`,
      );
    }
  });
  return messages;
}

function parseBindingRow(row: GitHubCliBindingRow): StoredGitHubCliBinding {
  if (row.singleton !== 1) throw new Error('singleton identity is invalid');
  let value: unknown;
  try {
    value = JSON.parse(row.value_json) as unknown;
  } catch {
    throw new Error('binding JSON is invalid');
  }
  return StoredGitHubCliBindingSchema.parse(value);
}
