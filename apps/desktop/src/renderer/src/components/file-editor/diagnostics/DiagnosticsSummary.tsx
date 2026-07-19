import type { FileDiagnosticsState } from './model.js';
import './DiagnosticsSummary.css';

export function DiagnosticsSummary({ state }: { readonly state: FileDiagnosticsState }) {
  if (state.availability === 'loading') {
    return (
      <span className="file-diagnostics-status" role="status">
        Checking for problems…
      </span>
    );
  }
  if (state.availability === 'unavailable') {
    return (
      <span
        className="file-diagnostics-status"
        role="status"
        aria-label="Problem check unavailable: this file type has no built-in problem checking"
      >
        Problem check unavailable
      </span>
    );
  }

  const errors = state.items.filter((item) => item.severity === 'error').length;
  const warnings = state.items.filter((item) => item.severity === 'warning').length;
  if (state.items.length === 0) {
    return (
      <span className="file-diagnostics-status" role="status">
        No problems
      </span>
    );
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
