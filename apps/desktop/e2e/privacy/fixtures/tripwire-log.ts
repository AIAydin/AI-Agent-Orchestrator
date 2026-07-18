import { readFile } from 'node:fs/promises';

export interface TripwireRecord {
  readonly pid: number;
  readonly target: string;
  readonly transport: string;
}

export async function readTripwireLog(path: string): Promise<TripwireRecord[]> {
  const content = await readFile(path, 'utf8').catch((error: unknown) => {
    if (isMissingFileError(error)) return '';
    throw error;
  });
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TripwireRecord);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
