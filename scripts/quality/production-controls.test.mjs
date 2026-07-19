import assert from 'node:assert/strict';
import test from 'node:test';

import { auditProductionSource } from './production-controls.mjs';

test('rejects explicit unfinished, fake-success, placeholder, and stub implementation markers', () => {
  const source = `
    // TODO: wire the real operation
    const state = 'fake success';
    const first = 'placeholder implementation';
    const second = 'stub response';
    throw new Error('Not implemented');
  `;
  assert.deepEqual(
    auditProductionSource(source, 'apps/example/src/broken.ts').map(({ label }) => label),
    [
      'unfinished-work marker',
      'fake-success marker',
      'placeholder/stub implementation marker',
      'placeholder/stub implementation marker',
      'unimplemented-feature marker',
    ],
  );
});

test('rejects native buttons and links whose action is hidden, absent, or non-literal', () => {
  const source = `
    export function Broken(props) {
      return <>
        <button>Save</button>
        <button {...props}>Hidden</button>
        <button type={props.type}>Maybe</button>
        <button onClick={() => undefined}>No-op</button>
        <a>Help</a>
        <a onClick={() => {}}>Also no-op</a>
        <a href="#">Empty fragment</a>
      </>;
    }
  `;
  assert.deepEqual(
    auditProductionSource(source, 'apps/example/src/Broken.tsx').map(({ label }) => label),
    [
      'inert native button',
      'inert native button',
      'inert native button',
      'inert native button',
      'inert native link',
      'inert native link',
      'inert native link',
    ],
  );
});

test('accepts explicit native actions and ordinary user-facing input placeholders', () => {
  const source = `
    export function Working({ cancel }) {
      return <form>
        <input placeholder="Repository name" />
        <button type="submit">Save</button>
        <button onClick={cancel}>Cancel</button>
        <button onClick={() => void cancel()}>Close</button>
        <a href="/help">Help</a>
        <a href={'/guide'}>Guide</a>
      </form>;
    }
  `;
  assert.deepEqual(auditProductionSource(source, 'apps/example/src/Working.tsx'), []);
});
