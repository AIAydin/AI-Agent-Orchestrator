import { z } from 'zod';

import { NODE_KINDS, type BuiltInNodeKind } from '../../canvas/CanvasNode.js';
import type { EdgeKind } from '../../model/types.js';

const TemplateNodeSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    kind: z.enum(NODE_KINDS),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    x: z.number().finite(),
    y: z.number().finite(),
    prompt: z.string().min(1).max(10_000).optional(),
    markdown: z.string().min(1).max(100_000).optional(),
  })
  .strict();

const TemplateEdgeSchema = z
  .object({
    source: z.string(),
    target: z.string(),
    type: z.enum(['context', 'execute', 'output', 'review', 'revision', 'dependency']),
    outputKind: z.enum(['branch', 'diff', 'preview', 'test-result', 'artifact']).optional(),
    reviewer: z.enum(['human', 'agent', 'gate']).optional(),
    revisionLoop: z.boolean().optional(),
  })
  .strict();

const WorkflowTemplateSchema = z
  .object({
    id: z.enum([
      'single-agent',
      'parallel-implementations',
      'implement-review-loop',
      'bug-investigation',
      'multi-screen-product-build',
    ]),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    nodes: z.array(TemplateNodeSchema).min(1).max(20),
    edges: z.array(TemplateEdgeSchema).max(40),
  })
  .strict()
  .superRefine((template, context) => {
    const keys = new Set<string>();
    for (const [index, node] of template.nodes.entries()) {
      if (keys.has(node.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'key'],
          message: 'Workflow template node keys must be unique.',
        });
      }
      keys.add(node.key);
    }
    for (const [index, edge] of template.edges.entries()) {
      if (!keys.has(edge.source) || !keys.has(edge.target) || edge.source === edge.target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index],
          message: 'Workflow template edges must connect two distinct declared nodes.',
        });
      }
      if (edge.revisionLoop === true && edge.type !== 'revision') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'revisionLoop'],
          message: 'Only revision edges can define a bounded revision loop.',
        });
      }
    }
  });

export type WorkflowTemplateId = z.infer<typeof WorkflowTemplateSchema>['id'];
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;
export type WorkflowTemplateNode = WorkflowTemplate['nodes'][number] & {
  readonly kind: BuiltInNodeKind;
};
export type WorkflowTemplateEdge = WorkflowTemplate['edges'][number] & {
  readonly type: EdgeKind;
};

const catalog = [
  {
    id: 'single-agent',
    name: 'Single agent',
    description: 'Give one agent a brief, run project tests, then pause for human approval.',
    nodes: [
      node('brief', 'brief', 'Work brief', 'Describe the outcome and acceptance criteria.', 0, 0, {
        markdown: '# Work brief\n\nDescribe what should change and how you will know it works.',
      }),
      node(
        'implement',
        'agent',
        'Implement',
        'Complete the brief in an isolated worktree.',
        340,
        0,
        {
          prompt: 'Implement the attached brief. Keep the change focused and verify it locally.',
        },
      ),
      node('test', 'test', 'Verify', 'Run the configured project test command.', 680, 0),
      node(
        'approve',
        'review-gate',
        'Approve result',
        'Review the implementation and test evidence.',
        1020,
        0,
      ),
    ],
    edges: [
      edge('brief', 'implement', 'context'),
      edge('implement', 'test', 'execute'),
      edge('test', 'approve', 'review', { reviewer: 'gate' }),
    ],
  },
  {
    id: 'parallel-implementations',
    name: 'Parallel implementations',
    description: 'Send the same brief to two agents and compare both results at one review gate.',
    nodes: [
      node('brief', 'brief', 'Shared brief', 'The same requirements for both approaches.', 0, 180, {
        markdown:
          '# Shared brief\n\nDescribe the result both agents should implement independently.',
      }),
      node(
        'option-a',
        'agent',
        'Implementation A',
        'Build the first independent approach.',
        360,
        0,
        {
          prompt:
            'Implement the shared brief independently. Favor the simplest maintainable approach.',
        },
      ),
      node(
        'option-b',
        'agent',
        'Implementation B',
        'Build an alternative independent approach.',
        360,
        360,
        {
          prompt: 'Implement the shared brief independently. Explore a sound alternative design.',
        },
      ),
      node(
        'compare',
        'agent',
        'Compare approaches',
        'Review both independent implementations.',
        760,
        180,
        {
          prompt:
            'Compare both implementations against the shared brief. Recommend one with specific evidence.',
        },
      ),
      node(
        'approve',
        'review-gate',
        'Approve approach',
        'Choose an implementation using exact evidence.',
        1120,
        180,
      ),
    ],
    edges: [
      edge('brief', 'option-a', 'context'),
      edge('brief', 'option-b', 'context'),
      edge('option-a', 'compare', 'output', { outputKind: 'branch' }),
      edge('option-b', 'compare', 'output', { outputKind: 'branch' }),
      edge('compare', 'approve', 'review', { reviewer: 'gate' }),
    ],
  },
  {
    id: 'implement-review-loop',
    name: 'Implement / review loop',
    description: 'Have one agent implement and another review through a bounded revision loop.',
    nodes: [
      node(
        'brief',
        'brief',
        'Implementation brief',
        'Define the change and acceptance criteria.',
        0,
        120,
        {
          markdown:
            '# Implementation brief\n\nDescribe the required behavior and verification evidence.',
        },
      ),
      node('implement', 'agent', 'Implement', 'Create or revise the implementation.', 380, 0, {
        prompt: 'Implement the attached brief and address every actionable reviewer finding.',
      }),
      node(
        'review',
        'agent',
        'Review',
        'Inspect the implementation and return actionable findings.',
        760,
        240,
        {
          prompt:
            'Review the implementation against the brief. Return specific actionable findings.',
        },
      ),
    ],
    edges: [
      edge('brief', 'implement', 'context'),
      edge('implement', 'review', 'review', { reviewer: 'agent' }),
      edge('review', 'implement', 'revision', { revisionLoop: true }),
    ],
  },
  {
    id: 'bug-investigation',
    name: 'Bug investigation',
    description:
      'Reproduce a bug, investigate it with an agent, verify the fix, and review evidence.',
    nodes: [
      node(
        'report',
        'brief',
        'Bug report',
        'Record symptoms, reproduction steps, and expected behavior.',
        0,
        0,
        {
          markdown:
            '# Bug report\n\nRecord the symptoms, exact reproduction steps, expected behavior, and any known regression range.',
        },
      ),
      node(
        'investigate',
        'agent',
        'Investigate and fix',
        'Find the root cause and implement a focused fix.',
        350,
        0,
        {
          prompt:
            'Reproduce the reported bug, identify the root cause, implement a focused fix, and explain the evidence.',
        },
      ),
      node(
        'regression',
        'test',
        'Regression test',
        'Run the configured project tests after the fix.',
        700,
        0,
      ),
      node(
        'review',
        'review-gate',
        'Review fix',
        'Confirm the root cause, regression proof, and impact.',
        1050,
        0,
      ),
    ],
    edges: [
      edge('report', 'investigate', 'context'),
      edge('investigate', 'regression', 'execute'),
      edge('regression', 'review', 'review', { reviewer: 'gate' }),
    ],
  },
  {
    id: 'multi-screen-product-build',
    name: 'Multi-screen product build',
    description:
      'Build from one product brief and inspect desktop and mobile previews before approval.',
    nodes: [
      node(
        'brief',
        'brief',
        'Product brief',
        'Define the product behavior across screen sizes.',
        0,
        180,
        {
          markdown:
            '# Product brief\n\nDescribe the user journey, desktop layout, mobile layout, and acceptance criteria.',
        },
      ),
      node(
        'build',
        'agent',
        'Build product',
        'Implement the product experience across screen sizes.',
        360,
        180,
        {
          prompt:
            'Build the attached product brief. Verify responsive behavior on desktop and mobile.',
        },
      ),
      node(
        'desktop',
        'web-preview',
        'Desktop preview',
        'Inspect the running desktop experience.',
        740,
        0,
      ),
      node(
        'mobile',
        'mobile-preview',
        'Mobile preview',
        'Inspect phone and tablet layouts side by side.',
        740,
        360,
      ),
      node('test', 'test', 'Product checks', 'Run the configured project tests.', 740, 720),
      node(
        'review',
        'agent',
        'Review implementation',
        'Review the implementation and tests before human cross-screen inspection.',
        1120,
        360,
        {
          prompt:
            'Review the implementation and test evidence against the product brief. Flag responsive risks for human inspection in the companion desktop and mobile preview nodes.',
        },
      ),
      node(
        'approve',
        'review-gate',
        'Approve product',
        'Approve the cross-screen product review.',
        1480,
        360,
      ),
    ],
    edges: [
      edge('brief', 'build', 'context'),
      edge('build', 'test', 'execute'),
      edge('build', 'review', 'review', { reviewer: 'agent' }),
      edge('test', 'review', 'output', { outputKind: 'test-result' }),
      edge('review', 'approve', 'review', { reviewer: 'gate' }),
    ],
  },
] satisfies WorkflowTemplate[];

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = Object.freeze(
  catalog.map((template) => Object.freeze(WorkflowTemplateSchema.parse(template))),
);

export function workflowTemplateById(id: WorkflowTemplateId): WorkflowTemplate {
  const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === id);
  if (template === undefined) throw new Error(`Unknown workflow template: ${id}`);
  return template;
}

function node(
  key: string,
  kind: BuiltInNodeKind,
  title: string,
  description: string,
  x: number,
  y: number,
  content: { readonly prompt?: string; readonly markdown?: string } = {},
): WorkflowTemplateNode {
  return { key, kind, title, description, x, y, ...content };
}

function edge(
  source: string,
  target: string,
  type: EdgeKind,
  options: Pick<WorkflowTemplateEdge, 'outputKind' | 'reviewer' | 'revisionLoop'> = {},
): WorkflowTemplateEdge {
  return { source, target, type, ...options };
}
