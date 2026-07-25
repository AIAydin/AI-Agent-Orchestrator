import { describe, expect, it, vi } from 'vitest';

import { createWorkspacePaletteActions } from './palette-actions.js';

describe('workspace palette action registry', () => {
  it('registers provider-specific voice actions and confirms only destructive ones', () => {
    const addAgentNode = vi.fn();
    const addDefaultAgentNode = vi.fn();
    const actions = createWorkspacePaletteActions({
      runnableAgents: [
        {
          id: 'claude',
          label: 'Claude Code',
          installed: true,
          executable: '/usr/bin/claude',
          version: '1.0.0',
          providerDisclosure: 'Provider fixture.',
        },
      ],
      extensionTemplates: [],
      selectedNodeTitle: null,
      selectedWorkflowScope: undefined,
      canRunWorkflow: true,
      workflowMutationsAuthorized: true,
      workflowStartBusy: false,
      addNode: vi.fn(),
      addAgentNode,
      addDefaultAgentNode,
      addExtensionNode: vi.fn(),
      fitCanvas: vi.fn(),
      startWorkflow: vi.fn(),
      openGitReview: vi.fn(),
      openSettings: vi.fn(),
      closeProject: vi.fn(),
    });

    const claude = actions.find((action) => action.id === 'add-agent-claude');
    expect(claude?.voiceAliases).toContain('create a Claude Code agent');
    expect(claude?.voiceAliases).toContain('start a Claude Code agent');
    expect(claude?.voiceSafety).toBe('safe');
    claude?.run();
    expect(addAgentNode).toHaveBeenCalledWith('claude');
    expect(actions.find((action) => action.id === 'run-workflow')?.voiceSafety).toBe('safe');
    expect(actions.find((action) => action.id === 'close')?.voiceSafety).toBe('confirm');

    actions.find((action) => action.id === 'add-agent')?.run();
    expect(addDefaultAgentNode).toHaveBeenCalledTimes(1);
    // Retired templates never appear as palette actions.
    expect(actions.find((action) => action.id === 'add-task')).toBeUndefined();
  });
});
