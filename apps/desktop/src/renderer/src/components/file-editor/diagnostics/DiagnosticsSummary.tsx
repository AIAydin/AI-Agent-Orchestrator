import type { FileDiagnosticsState } from './model.js';
import './DiagnosticsSummary.css';

export function DiagnosticsSummary({ state }: { readonly state: FileDiagnosticsState }) {
  if (state.availability === 'loading') {
    return <span className="file-diagnostics-status">Diagnostics loading…</span>;
  }
  if (state.availability === 'unavailable') {
    return (
      <span className="file-diagnostics-status" title="No Monaco diagnostics provider is active.">
        Diagnostics unavailable
      </span>
    );
  }

  const errors = state.items.filter((item) => item.severity === 'error').length;
  const warnings = state.items.filter((item) => item.severity === 'warning').length;
  if (state.items.length === 0) {
    return <span className="file-diagnostics-status">Problems 0</span>;
  }
  return (
    <details className="file-diagnostics">
      <summary>
        Problems {state.items.length} · {errors} errors · {warnings} warnings
      </summary>
      <ol>
        {state.items.map((item, index) => (
          <li key={`${item.line}:${item.column}:${index}`} data-severity={item.severity}>
            <strong>{item.severity}</strong>
            <span>{item.message}</span>
            <code>
              {item.line}:{item.column}
            </code>
          </li>
        ))}
      </ol>
    </details>
  );
}
