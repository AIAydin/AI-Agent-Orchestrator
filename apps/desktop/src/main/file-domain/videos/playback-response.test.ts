import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { videoPlaybackResponse } from './playback-response.js';

describe('videoPlaybackResponse', () => {
  let fixtureRoot: string;
  let fileUrl: string;

  beforeEach(async () => {
    fixtureRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'forgeboard-playback-')));
    const videoPath = path.join(fixtureRoot, 'demo.mp4');
    await writeFile(videoPath, 'ABCDEFGHIJ');
    fileUrl = pathToFileURL(videoPath).toString();
  });

  afterEach(async () => await rm(fixtureRoot, { recursive: true, force: true }));

  it('serves the whole file when no range is requested', async () => {
    const response = await videoPlaybackResponse(fileUrl, { method: 'GET', rangeHeader: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Type')).toBe('video/mp4');
    expect(response.headers.get('Content-Length')).toBe('10');
    await expect(response.text()).resolves.toBe('ABCDEFGHIJ');
  });

  it('answers an open-ended range with 206 partial content', async () => {
    const response = await videoPlaybackResponse(fileUrl, {
      method: 'GET',
      rangeHeader: 'bytes=2-',
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 2-9/10');
    await expect(response.text()).resolves.toBe('CDEFGHIJ');
  });

  it('answers bounded and tail ranges, clamping past-the-end offsets', async () => {
    const bounded = await videoPlaybackResponse(fileUrl, {
      method: 'GET',
      rangeHeader: 'bytes=1-3',
    });
    expect(bounded.headers.get('Content-Range')).toBe('bytes 1-3/10');
    await expect(bounded.text()).resolves.toBe('BCD');

    const tail = await videoPlaybackResponse(fileUrl, { method: 'GET', rangeHeader: 'bytes=-4' });
    expect(tail.headers.get('Content-Range')).toBe('bytes 6-9/10');
    await expect(tail.text()).resolves.toBe('GHIJ');

    const clamped = await videoPlaybackResponse(fileUrl, {
      method: 'GET',
      rangeHeader: 'bytes=8-99',
    });
    expect(clamped.headers.get('Content-Range')).toBe('bytes 8-9/10');
    await expect(clamped.text()).resolves.toBe('IJ');
  });

  it('rejects unsatisfiable ranges with 416 and the total size', async () => {
    const response = await videoPlaybackResponse(fileUrl, {
      method: 'GET',
      rangeHeader: 'bytes=99-',
    });
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
    expect(response.body).toBeNull();
  });

  it('answers HEAD with headers only', async () => {
    const response = await videoPlaybackResponse(fileUrl, {
      method: 'HEAD',
      rangeHeader: 'bytes=0-',
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.body).toBeNull();
  });

  it('serves the whole file for unrecognized multi-range headers', async () => {
    const response = await videoPlaybackResponse(fileUrl, {
      method: 'GET',
      rangeHeader: 'bytes=0-1,4-5',
    });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('ABCDEFGHIJ');
  });
});
