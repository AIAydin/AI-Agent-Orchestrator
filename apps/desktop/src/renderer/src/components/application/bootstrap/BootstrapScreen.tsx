import { LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';

import { BrandMark } from '../../shell/BrandMark.js';

interface BootstrapScreenProps {
  readonly error: string | null;
  readonly onRetry: () => void;
}

/** Honest full-window state while Forgeboard loads its local application data. */
export function BootstrapScreen({ error, onRetry }: BootstrapScreenProps) {
  const failed = error !== null;

  return (
    <main className={`loading-screen${failed ? ' failed' : ''}`} aria-busy={!failed}>
      <BrandMark size={48} />
      {failed ? (
        <>
          <TriangleAlert className="loading-screen-error-icon" aria-hidden="true" />
          <section className="loading-screen-message" role="alert" aria-labelledby="startup-error">
            <h1 id="startup-error">Forgeboard couldn&apos;t open</h1>
            <p>{error}</p>
          </section>
          <button className="button primary" type="button" onClick={onRetry}>
            <RotateCcw size={15} aria-hidden="true" /> Try again
          </button>
          <small>Your projects and settings weren&apos;t changed.</small>
        </>
      ) : (
        <>
          <LoaderCircle className="spin" aria-hidden="true" />
          <p role="status">Opening Forgeboard…</p>
        </>
      )}
    </main>
  );
}
