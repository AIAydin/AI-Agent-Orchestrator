import type { CanvasNode } from '@forgeboard/core/domain';

const MAX_AGENT_PROMPT_CODE_UNITS = 1_000_000;

export type CanonicalTaskNode = Extract<CanvasNode, { type: 'task' }>;
export type CanonicalAgentNode = Extract<CanvasNode, { type: 'agent' }>;

/** Resolves a Task's explicit assignee without guessing or falling back to a default agent. */
export function assignedAgentForTask(
  task: CanonicalTaskNode,
  nodes: readonly CanvasNode[],
): CanonicalAgentNode {
  const assigneeId = task.data.assigneeId;
  if (assigneeId === undefined) {
    throw new Error(`Task node "${task.title}" needs an assigned Agent node before it can run.`);
  }
  const assignee = nodes.find((candidate) => candidate.id === assigneeId);
  if (assignee === undefined) {
    throw new Error(
      `Task node "${task.title}" references missing assignee "${assigneeId}". Choose an existing Agent node.`,
    );
  }
  if (assignee.type !== 'agent') {
    throw new Error(`Task node "${task.title}" assignee "${assigneeId}" is not an Agent node.`);
  }
  return assignee;
}

/**
 * Produces the stable task instruction reviewed in the normal agent launch disclosure. Related
 * files are deliberately path metadata only; content is available only through explicit Context
 * edges selected for this Task.
 */
export function workflowTaskPrompt(task: CanonicalTaskNode, projectId: string): string {
  const foreignReference = task.data.relatedFiles.find((file) => file.projectId !== projectId);
  if (foreignReference !== undefined) {
    throw new Error(
      `Task node "${task.title}" contains related-file metadata from another project.`,
    );
  }
  const criteria = task.data.acceptanceCriteria.map(
    (criterion, index) =>
      `${String(index + 1)}. [${criterion.satisfied ? 'satisfied' : 'open'}] ${criterion.description}`,
  );
  const relatedFiles = [...task.data.relatedFiles]
    .sort((left, right) => {
      const pathOrder = left.relativePath.localeCompare(right.relativePath);
      return pathOrder === 0 ? left.kind.localeCompare(right.kind) : pathOrder;
    })
    .map(
      (file) =>
        `- ${file.relativePath} (${file.kind}; ${file.missing ? 'marked missing' : 'present when configured'}${
          file.lastKnownHash === undefined ? '' : `; last-known hash ${file.lastKnownHash}`
        })`,
    );
  const prompt = [
    '# Artemis task execution',
    '',
    `Title: ${task.title}`,
    `Priority: ${task.data.priority}`,
    '',
    '## Description',
    task.data.description.trim() || '(No description provided.)',
    '',
    '## Acceptance criteria',
    ...(criteria.length === 0 ? ['(No acceptance criteria configured.)'] : criteria),
    '',
    '## Related file metadata',
    'Paths below are metadata only. File content is available only when explicitly attached through a Context connection.',
    ...(relatedFiles.length === 0 ? ['(No related files configured.)'] : relatedFiles),
    '',
    'Complete the task and report the concrete changes and verification performed.',
  ].join('\n');
  if (prompt.length > MAX_AGENT_PROMPT_CODE_UNITS) {
    throw new Error(
      `Task node "${task.title}" produces a prompt larger than the supported 1,000,000 characters.`,
    );
  }
  return prompt;
}
