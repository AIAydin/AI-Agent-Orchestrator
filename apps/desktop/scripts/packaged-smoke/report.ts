import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  PACKAGED_SMOKE_MARKER,
  PackagedSmokeReportSchema,
  type PackagedSmokeReport,
} from '../../src/shared/packaged-smoke.js';

const SQLITE_HEADER = 'SQLite format 3\0';

export function parsePackagedSmokeReport(output: string): PackagedSmokeReport {
  const prefix = `${PACKAGED_SMOKE_MARKER} `;
  const matching = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  if (matching.length !== 1) {
    throw new Error(
      `Packaged Forgeboard produced ${String(matching.length)} valid smoke marker lines. Output:\n${output}`,
    );
  }
  try {
    return PackagedSmokeReportSchema.parse(JSON.parse(matching[0]?.slice(prefix.length) ?? ''));
  } catch (error) {
    throw new Error('Packaged Forgeboard returned an invalid smoke readiness report.', {
      cause: error,
    });
  }
}

export function assertSmokeReportProfile(report: PackagedSmokeReport, profileRoot: string): void {
  if (
    resolve(report.profilePath) !== resolve(profileRoot) ||
    resolve(report.databasePath) !== resolve(profileRoot, 'forgeboard.sqlite')
  ) {
    throw new Error('Packaged Forgeboard reported a path outside its disposable smoke profile.');
  }
}

export async function assertSqliteDatabase(databasePath: string): Promise<void> {
  const file = await readFile(databasePath);
  if (
    file.byteLength <= SQLITE_HEADER.length ||
    file.subarray(0, 16).toString() !== SQLITE_HEADER
  ) {
    throw new Error('Packaged Forgeboard did not create a valid SQLite database.');
  }
}
