import {
  AgentAdapterManifestSchema,
  NamespacedAgentAdapterIdSchema,
} from '@forgeboard/agent-adapters';
import { z } from 'zod';

export const EXTENSION_API_VERSION = 1 as const;
export const EXTENSION_MANIFEST_FILENAME = 'forgeboard-extension.json';
export const EXTENSION_RUNTIME_VERSION = '0.1.0';

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u);

export const SemanticVersionSchema = z
  .string()
  .max(128)
  .regex(
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    'Version must be a strict Semantic Version 2.0.0 value.',
  );

const SafeRelativeDocumentationPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes('\0'), 'Documentation paths cannot contain NUL bytes.')
  .refine((value) => !value.includes('\\'), 'Documentation paths must use forward slashes.')
  .refine((value) => !value.startsWith('/'), 'Documentation paths must be relative.')
  .refine((value) => !/^[A-Za-z]:/u.test(value), 'Documentation paths cannot use a drive prefix.')
  .refine(
    (value) =>
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Documentation paths cannot be empty or traverse directories.',
  )
  .refine(
    (value) => /\.(?:md|txt)$/iu.test(value),
    'Documentation resources must be Markdown or plain text.',
  );

export const ExtensionPermissionSchema = z.enum([
  'agent.adapter.register',
  'agent.process.launch',
  'agent.context.selected-read',
  'agent.provider.network',
  'canvas.node.register',
  'canvas.data.persist',
]);
export type ExtensionPermission = z.infer<typeof ExtensionPermissionSchema>;

export const CanvasNodeCapabilitySchema = z.enum([
  'context-source',
  'context-target',
  'workflow-input',
  'workflow-output',
  'human-editable',
  'run-history',
]);

const FieldBaseSchema = z.object({
  id: IdentifierSchema,
  label: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(1_024).optional(),
  required: z.boolean().default(false),
});

const TextFieldSchema = FieldBaseSchema.extend({
  kind: z.enum(['text', 'multiline', 'markdown']),
  defaultValue: z.string().max(100_000).optional(),
  maxLength: z.number().int().min(1).max(100_000).optional(),
}).strict();

const NumberFieldSchema = FieldBaseSchema.extend({
  kind: z.literal('number'),
  defaultValue: z.number().finite().optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
}).strict();

const BooleanFieldSchema = FieldBaseSchema.extend({
  kind: z.literal('boolean'),
  defaultValue: z.boolean().optional(),
}).strict();

const SelectFieldSchema = FieldBaseSchema.extend({
  kind: z.literal('select'),
  options: z
    .array(
      z
        .object({
          label: z.string().trim().min(1).max(128),
          value: z.string().min(1).max(512),
        })
        .strict(),
    )
    .min(1)
    .max(128),
  defaultValue: z.string().min(1).max(512).optional(),
}).strict();

const LocalReferenceFieldSchema = FieldBaseSchema.extend({
  kind: z.enum(['file-reference', 'directory-reference']),
  multiple: z.boolean().default(false),
}).strict();

export const CanvasNodeFieldSchema = z.discriminatedUnion('kind', [
  TextFieldSchema,
  NumberFieldSchema,
  BooleanFieldSchema,
  SelectFieldSchema,
  LocalReferenceFieldSchema,
]);
export type CanvasNodeField = z.infer<typeof CanvasNodeFieldSchema>;

export const CanvasNodePortSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string().trim().min(1).max(128),
    direction: z.enum(['input', 'output']),
    dataType: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency', 'any']),
    multiple: z.boolean().default(false),
  })
  .strict();

export const CanvasNodeTypeManifestSchema = z
  .object({
    id: IdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2_048),
    category: z.string().trim().min(1).max(128),
    icon: z.enum([
      'bot',
      'box',
      'check-circle',
      'file',
      'git-branch',
      'image',
      'layout',
      'note',
      'play',
      'terminal',
      'workflow',
    ]),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/u),
    capabilities: z.array(CanvasNodeCapabilitySchema).max(16),
    fields: z.array(CanvasNodeFieldSchema).max(64),
    ports: z.array(CanvasNodePortSchema).max(32),
  })
  .strict()
  .superRefine((nodeType, context) => {
    const fieldIds = new Set<string>();
    for (const [index, field] of nodeType.fields.entries()) {
      if (fieldIds.has(field.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'id'],
          message: `Duplicate field id: ${field.id}`,
        });
      }
      fieldIds.add(field.id);

      if (field.kind === 'number') {
        if (
          field.minimum !== undefined &&
          field.maximum !== undefined &&
          field.minimum > field.maximum
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fields', index, 'minimum'],
            message: 'A number field minimum cannot exceed its maximum.',
          });
        }
        if (
          field.defaultValue !== undefined &&
          ((field.minimum !== undefined && field.defaultValue < field.minimum) ||
            (field.maximum !== undefined && field.defaultValue > field.maximum))
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fields', index, 'defaultValue'],
            message: 'The default number must be within the declared range.',
          });
        }
      }

      if (
        field.kind === 'select' &&
        field.defaultValue !== undefined &&
        !field.options.some((option) => option.value === field.defaultValue)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields', index, 'defaultValue'],
          message: 'The default selection must match an option value.',
        });
      }
    }

    const portIds = new Set<string>();
    for (const [index, port] of nodeType.ports.entries()) {
      if (portIds.has(port.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ports', index, 'id'],
          message: `Duplicate port id: ${port.id}`,
        });
      }
      portIds.add(port.id);
    }

    const capabilities = new Set(nodeType.capabilities);
    if (capabilities.size !== nodeType.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities'],
        message: 'Node capabilities must be unique.',
      });
    }
  });
export type CanvasNodeTypeManifest = z.infer<typeof CanvasNodeTypeManifestSchema>;

const ExtensionManifestBaseSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_API_VERSION),
    id: IdentifierSchema,
    name: z.string().trim().min(1).max(128),
    version: SemanticVersionSchema,
    description: z.string().trim().min(1).max(4_096),
    publisher: z.string().trim().min(1).max(256),
    requestedPermissions: z.array(ExtensionPermissionSchema).max(16),
    documentationFile: SafeRelativeDocumentationPathSchema.optional(),
    contributes: z
      .object({
        agentAdapters: z.array(AgentAdapterManifestSchema).max(16).default([]),
        canvasNodeTypes: z.array(CanvasNodeTypeManifestSchema).max(32).default([]),
      })
      .strict(),
  })
  .strict();

export type ExtensionManifest = z.infer<typeof ExtensionManifestBaseSchema>;

export function requiredPermissionsForManifest(
  manifest: Pick<ExtensionManifest, 'contributes'>,
): ExtensionPermission[] {
  const permissions = new Set<ExtensionPermission>();
  if (manifest.contributes.canvasNodeTypes.length > 0) {
    permissions.add('canvas.node.register');
    permissions.add('canvas.data.persist');
  }
  if (manifest.contributes.agentAdapters.length > 0) {
    permissions.add('agent.adapter.register');
    permissions.add('agent.process.launch');
  }
  if (
    manifest.contributes.agentAdapters.some((adapter) => adapter.capabilities.contextAttachments)
  ) {
    permissions.add('agent.context.selected-read');
  }
  if (
    manifest.contributes.agentAdapters.some((adapter) => adapter.provider.sendsContextOffDevice)
  ) {
    permissions.add('agent.provider.network');
  }
  return [...permissions].sort();
}

export const ExtensionManifestSchema = ExtensionManifestBaseSchema.superRefine(
  (manifest, context) => {
    if (
      manifest.contributes.agentAdapters.length === 0 &&
      manifest.contributes.canvasNodeTypes.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributes'],
        message: 'An extension must contribute at least one adapter or canvas node type.',
      });
    }

    const requested = new Set(manifest.requestedPermissions);
    if (requested.size !== manifest.requestedPermissions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedPermissions'],
        message: 'Requested permissions must be unique.',
      });
    }

    const required = requiredPermissionsForManifest(manifest);
    for (const permission of required) {
      if (!requested.has(permission)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requestedPermissions'],
          message: `Contribution requires explicit permission: ${permission}`,
        });
      }
    }
    for (const permission of requested) {
      if (!required.includes(permission)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requestedPermissions'],
          message: `Permission is not justified by this manifest: ${permission}`,
        });
      }
    }

    for (const [index, adapter] of manifest.contributes.agentAdapters.entries()) {
      if (!NamespacedAgentAdapterIdSchema.safeParse(adapter.id).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'agentAdapters', index, 'id'],
          message: 'Extension agent adapter ids must use non-empty dot-separated namespaces.',
        });
      }
      if (!adapter.id.startsWith(`${manifest.id}.`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contributes', 'agentAdapters', index, 'id'],
          message: `Agent adapter ids must be namespaced with ${manifest.id}.`,
        });
      }
    }

    const adapterIds = manifest.contributes.agentAdapters.map((adapter) => adapter.id);
    if (new Set(adapterIds).size !== adapterIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributes', 'agentAdapters'],
        message: 'Agent adapter ids must be unique.',
      });
    }

    const nodeTypeIds = manifest.contributes.canvasNodeTypes.map((nodeType) => nodeType.id);
    if (new Set(nodeTypeIds).size !== nodeTypeIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contributes', 'canvasNodeTypes'],
        message: 'Canvas node type ids must be unique.',
      });
    }
  },
);

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  return ExtensionManifestSchema.parse(value);
}

export function extensionNodeTypeId(extensionId: string, nodeTypeId: string): string {
  return `${IdentifierSchema.parse(extensionId)}.${IdentifierSchema.parse(nodeTypeId)}`;
}

export const ExtensionApprovalSchema = z
  .object({
    extensionId: IdentifierSchema,
    version: SemanticVersionSchema,
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    permissions: z.array(ExtensionPermissionSchema).max(16),
    confirmed: z.literal(true),
    approvedAt: z.string().datetime(),
  })
  .strict();
export type ExtensionApproval = z.infer<typeof ExtensionApprovalSchema>;

export const InstalledExtensionRecordSchema = z
  .object({
    schemaVersion: z.literal(EXTENSION_API_VERSION),
    extensionId: IdentifierSchema,
    version: SemanticVersionSchema,
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    grantedPermissions: z.array(ExtensionPermissionSchema).max(16),
    sourcePath: z.string().min(1).max(32_768),
    installedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type InstalledExtensionRecord = z.infer<typeof InstalledExtensionRecordSchema>;
