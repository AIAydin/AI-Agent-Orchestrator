import { AgentAdapterManifestSchema, type AgentAdapterManifest } from './schema.js';

const commonCapabilities = {
  interactiveInput: true,
  interrupt: true,
  terminate: true,
  pause: false,
  resume: true,
  ansiStreaming: true,
  structuredOutput: false,
  modelSelection: true,
  contextAttachments: true,
  permissionModes: ['plan-read-only', 'worktree-write', 'custom'],
} as const;

const invocationSlots = ['{permissionArgs}', '{modelArgs}', '{extraArgs}', '{prompt}'] as const;

export const CODEX_MANIFEST = AgentAdapterManifestSchema.parse({
  schemaVersion: 1,
  id: 'codex',
  name: 'OpenAI Codex CLI',
  provider: {
    name: 'OpenAI',
    website: 'https://developers.openai.com/codex/cli/',
    sendsContextOffDevice: true,
    disclosure:
      "Codex may send the prompt and files it reads to OpenAI under the user's Codex configuration and OpenAI terms.",
  },
  executable: {
    command: 'codex',
    versionArguments: ['--version'],
    versionPattern: '(?:codex-cli\\s+)?(?<version>\\d+(?:\\.\\d+)+)',
    capabilityProbe: {
      arguments: ['--help'],
      resume: ['resume'],
      modelSelection: ['--model'],
      permissionModes: {
        'plan-read-only': ['--sandbox', 'read-only'],
        'worktree-write': ['--sandbox', 'workspace-write'],
      },
    },
  },
  invocation: {
    runtime: 'pty',
    launchArguments: ['--no-alt-screen', ...invocationSlots],
    resumeArguments: [
      'resume',
      '--no-alt-screen',
      '{permissionArgs}',
      '{modelArgs}',
      '{extraArgs}',
      '{sessionId}',
      '{prompt}',
    ],
    promptTransport: 'argument',
    modelArguments: ['--model', '{model}'],
    context: { strategy: 'prompt-references' },
    permissionArguments: {
      'plan-read-only': ['--sandbox', 'read-only', '--ask-for-approval', 'untrusted'],
      'worktree-write': ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
      custom: [],
    },
    output: 'text',
  },
  capabilities: commonCapabilities,
  suggestedEnvironmentVariables: ['CODEX_HOME', 'OPENAI_API_KEY'],
});

export const CLAUDE_MANIFEST = AgentAdapterManifestSchema.parse({
  schemaVersion: 1,
  id: 'claude',
  name: 'Anthropic Claude Code',
  provider: {
    name: 'Anthropic',
    website: 'https://docs.anthropic.com/en/docs/claude-code/cli-usage',
    sendsContextOffDevice: true,
    disclosure:
      "Claude Code may send the prompt and files it reads to Anthropic or the provider selected in the user's Claude Code configuration.",
  },
  executable: {
    command: 'claude',
    versionArguments: ['--version'],
    versionPattern: '(?<version>\\d+(?:\\.\\d+)+)',
    capabilityProbe: {
      arguments: ['--help'],
      resume: ['--resume'],
      modelSelection: ['--model'],
      permissionModes: {
        'plan-read-only': ['--permission-mode', 'plan'],
        'worktree-write': ['--permission-mode', 'manual'],
      },
    },
  },
  invocation: {
    runtime: 'pty',
    launchArguments: invocationSlots,
    resumeArguments: [
      '{permissionArgs}',
      '{modelArgs}',
      '{extraArgs}',
      '--resume',
      '{sessionId}',
      '{prompt}',
    ],
    promptTransport: 'argument',
    modelArguments: ['--model', '{model}'],
    context: { strategy: 'prompt-references' },
    permissionArguments: {
      'plan-read-only': ['--permission-mode', 'plan'],
      'worktree-write': ['--permission-mode', 'manual'],
      custom: [],
    },
    output: 'text',
  },
  capabilities: commonCapabilities,
  suggestedEnvironmentVariables: [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ],
});

export const GEMINI_MANIFEST = AgentAdapterManifestSchema.parse({
  schemaVersion: 1,
  id: 'gemini',
  name: 'Google Gemini CLI',
  provider: {
    name: 'Google',
    website: 'https://geminicli.com/docs/cli/cli-reference/',
    sendsContextOffDevice: true,
    disclosure:
      "Gemini CLI may send the prompt and files it reads to Google or the provider selected in the user's Gemini configuration.",
  },
  executable: {
    command: 'gemini',
    versionArguments: ['--version'],
    versionPattern: '(?<version>\\d+(?:\\.\\d+)+)',
    capabilityProbe: {
      arguments: ['--help'],
      resume: ['--resume'],
      modelSelection: ['--model'],
      permissionModes: {
        'plan-read-only': ['--approval-mode', 'plan'],
        'worktree-write': ['--approval-mode', 'default'],
      },
    },
  },
  invocation: {
    runtime: 'pty',
    launchArguments: [
      '{permissionArgs}',
      '{modelArgs}',
      '{extraArgs}',
      '--prompt-interactive',
      '{prompt}',
    ],
    resumeArguments: [
      '{permissionArgs}',
      '{modelArgs}',
      '{extraArgs}',
      '--resume',
      '{sessionId}',
      '--prompt-interactive',
      '{prompt}',
    ],
    promptTransport: 'argument',
    modelArguments: ['--model', '{model}'],
    context: { strategy: 'prompt-references' },
    permissionArguments: {
      'plan-read-only': ['--approval-mode', 'plan'],
      'worktree-write': ['--approval-mode', 'default'],
      custom: [],
    },
    output: 'text',
  },
  capabilities: commonCapabilities,
  suggestedEnvironmentVariables: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
});

export const OPENCODE_MANIFEST = AgentAdapterManifestSchema.parse({
  schemaVersion: 1,
  id: 'opencode',
  name: 'OpenCode',
  provider: {
    name: 'OpenCode (configured model provider)',
    website: 'https://opencode.ai/docs/cli/',
    sendsContextOffDevice: true,
    disclosure:
      'OpenCode sends selected context to whichever model provider the user configured. The provider, retention, and terms depend on that configuration.',
  },
  executable: {
    command: 'opencode',
    versionArguments: ['--version'],
    versionPattern: '(?<version>\\d+(?:\\.\\d+)+)',
    capabilityProbe: {
      arguments: ['--help'],
      resume: ['--session'],
      modelSelection: ['--model'],
      permissionModes: {
        'worktree-write': ['--prompt'],
      },
    },
  },
  invocation: {
    runtime: 'pty',
    launchArguments: ['{permissionArgs}', '{modelArgs}', '{extraArgs}', '--prompt', '{prompt}'],
    resumeArguments: [
      '{permissionArgs}',
      '{modelArgs}',
      '{extraArgs}',
      '--session',
      '{sessionId}',
      '--prompt',
      '{prompt}',
    ],
    promptTransport: 'argument',
    modelArguments: ['--model', '{model}'],
    context: { strategy: 'prompt-references' },
    permissionArguments: {
      'worktree-write': [],
      custom: [],
    },
    output: 'text',
  },
  capabilities: {
    ...commonCapabilities,
    permissionModes: ['worktree-write', 'custom'],
  },
  suggestedEnvironmentVariables: [
    'OPENCODE_CONFIG',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
  ],
});

export const BUILT_IN_AGENT_MANIFESTS: readonly AgentAdapterManifest[] = Object.freeze([
  CODEX_MANIFEST,
  CLAUDE_MANIFEST,
  GEMINI_MANIFEST,
  OPENCODE_MANIFEST,
]);

export function getBuiltInAgentManifest(id: string): AgentAdapterManifest | undefined {
  return BUILT_IN_AGENT_MANIFESTS.find((manifest) => manifest.id === id);
}
