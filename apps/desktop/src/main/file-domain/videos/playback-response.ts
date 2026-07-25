import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
};

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Chromium's media stack fetches <video> sources with Range requests —
 * `bytes=0-` up front and tail ranges for MP4s whose index sits at the end of
 * the file. Proxying those through `net.fetch(file://…)` answers 200 with the
 * whole body, which makes such files fail to load or seek. This serves the
 * ranges directly from disk instead.
 */
export async function videoPlaybackResponse(
  fileUrl: string,
  request: { readonly method: string; readonly rangeHeader: string | null },
): Promise<Response> {
  const absolutePath = fileURLToPath(fileUrl);
  const { size } = await stat(absolutePath);
  const mimeType =
    MIME_TYPES[path.extname(absolutePath).toLowerCase()] ?? 'application/octet-stream';
  const shared = { 'Accept-Ranges': 'bytes', 'Content-Type': mimeType };
  const range = parseByteRange(request.rangeHeader, size);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...shared, 'Content-Range': `bytes */${size}` },
    });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const status = range === null ? 200 : 206;
  const headers = {
    ...shared,
    'Content-Length': String(Math.max(0, end - start + 1)),
    ...(range === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  };
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(absolutePath, { start, end })) as ReadableStream;
  return new Response(body, { status, headers });
}

/**
 * A single satisfiable `bytes=` range, `null` for "send the whole file"
 * (absent or unrecognized header), or `'unsatisfiable'` per RFC 9110.
 */
function parseByteRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  const match = header === null ? null : /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return null;
  const [, startText, endText] = match;
  if (startText === '' && endText === '') return 'unsatisfiable';
  if (startText === '') {
    const suffix = Number(endText);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (start >= size) return size === 0 && start === 0 ? null : 'unsatisfiable';
  const end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}
