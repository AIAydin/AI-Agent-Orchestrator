import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  PACKAGED_SMOKE_DEMO_PROJECT_NAME,
  PACKAGED_SMOKE_MARKER,
  PackagedSmokeReportSchema,
  type PackagedSmokeReport,
} from '../../src/shared/smoke/contracts.js';
import { ProjectSchema, CanvasDocumentSchema } from '../../src/shared/application/contracts.js';

const SQLITE_HEADER = 'SQLite format 3\0';

export function parsePackagedSmokeReport(output: string): PackagedSmokeReport {
  const prefix = `${PACKAGED_SMOKE_MARKER} `;
  const matching = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  if (matching.length !== 1) {
    throw new Error(
      `Packaged Artemis produced ${String(matching.length)} valid smoke marker lines. Output:\n${output}`,
    );
  }
  try {
    return PackagedSmokeReportSchema.parse(JSON.parse(matching[0]?.slice(prefix.length) ?? ''));
  } catch (error) {
    throw new Error('Packaged Artemis returned an invalid smoke readiness report.', {
      cause: error,
    });
  }
}

export function assertSmokeReportProfile(report: PackagedSmokeReport, profileRoot: string): void {
  if (
    resolve(report.profilePath) !== resolve(profileRoot) ||
    resolve(report.databasePath) !== resolve(profileRoot, 'forgeboard.sqlite') ||
    resolve(report.demoProjectPath) !==
      resolve(profileRoot, 'demo', PACKAGED_SMOKE_DEMO_PROJECT_NAME)
  ) {
    throw new Error('Packaged Artemis reported a path outside its disposable smoke profile.');
  }
}

export async function assertSqliteDatabase(databasePath: string): Promise<void> {
  const file = await readFile(databasePath);
  if (
    file.byteLength <= SQLITE_HEADER.length ||
    file.subarray(0, 16).toString() !== SQLITE_HEADER
  ) {
    throw new Error('Packaged Artemis did not create a valid SQLite database.');
  }
}

export function assertDurableSmokeState(report: PackagedSmokeReport): void {
  const database = new DatabaseSync(report.databasePath, { readOnly: true });
  try {
    const projectRow = database
      .prepare('SELECT value_json FROM recent_projects WHERE id = ?')
      .get(report.demoProjectId) as { value_json: string } | undefined;
    const canvasRow = database
      .prepare('SELECT value_json FROM canvas_documents WHERE id = ? AND project_id = ?')
      .get(report.demoCanvasId, report.demoProjectId) as { value_json: string } | undefined;
    const settingsRow = database
      .prepare('SELECT value_json FROM app_settings WHERE singleton = 1')
      .get() as { value_json: string } | undefined;
    if (!projectRow || !canvasRow || !settingsRow) {
      throw new Error('Packaged Artemis did not durably persist its smoke workspace.');
    }
    const project = ProjectSchema.parse(JSON.parse(projectRow.value_json));
    const canvas = CanvasDocumentSchema.parse(JSON.parse(canvasRow.value_json));
    const settings = JSON.parse(settingsRow.value_json) as { onboardingCompleted?: unknown };
    if (
      settings.onboardingCompleted !== true ||
      project.id !== report.demoProjectId ||
      project.name !== PACKAGED_SMOKE_DEMO_PROJECT_NAME ||
      resolve(project.path) !== resolve(report.demoProjectPath) ||
      project.missing ||
      canvas.id !== report.demoCanvasId ||
      canvas.projectId !== report.demoProjectId
    ) {
      throw new Error('Packaged Artemis reported smoke state that does not match durable data.');
    }
  } finally {
    database.close();
  }
}
