import type { Canvas } from '@forgeboard/core/domain';

export interface LegacyCanvasNode {
  readonly id: string;
  readonly type: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface LegacyCanvasEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: string | null | undefined;
  readonly targetHandle?: string | null | undefined;
  readonly type: Canvas['edges'][number]['type'];
  readonly data?: Readonly<Record<string, unknown>> | undefined;
}

export interface LegacyCanvasDocument {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly nodes: readonly LegacyCanvasNode[];
  readonly edges: readonly LegacyCanvasEdge[];
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly updatedAt: string;
  readonly canonical?: Canvas | undefined;
}

export type CanvasMigrationIssueCode =
  | 'INVALID_NODE_KIND'
  | 'INVALID_EXTENSION_NODE'
  | 'INVALID_TYPED_NODE'
  | 'INVALID_TYPED_EDGE'
  | 'NON_JSON_METADATA';

export interface CanvasMigrationIssue {
  readonly code: CanvasMigrationIssueCode;
  readonly entityId: string;
  readonly message: string;
}

export type CanvasMigrationResult =
  | { readonly ok: true; readonly canvas: Canvas }
  | { readonly ok: false; readonly issues: readonly CanvasMigrationIssue[] };

export interface LegacyCanvasSurface {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly nodes: readonly LegacyCanvasNode[];
  readonly edges: readonly LegacyCanvasEdge[];
  readonly viewport: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly updatedAt: string;
}
