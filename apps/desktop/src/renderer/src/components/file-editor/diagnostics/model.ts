export type FileDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface FileDiagnostic {
  readonly severity: FileDiagnosticSeverity;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export type FileDiagnosticsState =
  | { readonly availability: 'loading'; readonly items: readonly [] }
  | { readonly availability: 'unavailable'; readonly items: readonly [] }
  | { readonly availability: 'available'; readonly items: readonly FileDiagnostic[] };

interface MonacoMarkerLike {
  readonly severity: number;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
}

const MAX_VISIBLE_DIAGNOSTICS = 100;

export function diagnosticsFromMonacoMarkers(
  markers: readonly MonacoMarkerLike[],
): FileDiagnosticsState {
  return {
    availability: 'available',
    items: markers.slice(0, MAX_VISIBLE_DIAGNOSTICS).map((marker) => ({
      severity: diagnosticSeverity(marker.severity),
      message: marker.message.slice(0, 1_000),
      line: marker.startLineNumber,
      column: marker.startColumn,
    })),
  };
}

function diagnosticSeverity(severity: number): FileDiagnosticSeverity {
  if (severity >= 8) return 'error';
  if (severity >= 4) return 'warning';
  if (severity >= 2) return 'info';
  return 'hint';
}
