import { AgentAdapterManifestSchema, type AgentAdapterManifest } from '@forgeboard/agent-adapters';

import type { CustomAgentConfiguration } from '../shared/contracts.js';

/** Build the data-only adapter manifest owned by the Settings UI. */
export function customAgentManifest(configuration: CustomAgentConfiguration): AgentAdapterManifest {
  if (!configuration.enabled || configuration.executable.trim() === '') {
    throw new Error('Configure and enable the custom CLI in Settings before using it.');
  }
  const launchArguments = [
    ...configuration.launchArguments,
    ...(configuration.promptTransport === 'argument' ? ['{prompt}'] : []),
    '{extraArgs}',
  ];
  return AgentAdapterManifestSchema.parse({
    schemaVersion: 1,
    id: 'custom',
    name: configuration.name,
    provider: {
      name: configuration.providerName,
      sendsContextOffDevice: configuration.sendsContextOffDevice,
      disclosure: configuration.providerDisclosure,
    },
    executable: {
      command: configuration.executable,
      versionArguments: configuration.versionArguments,
      detectionTimeoutMs: 3_000,
    },
    invocation: {
      runtime: configuration.runtime,
      launchArguments,
      promptTransport: configuration.promptTransport,
      promptTerminator: '\n',
      modelArguments: [],
      context: { strategy: 'prompt-references' },
      permissionArguments: {},
      permissionArgumentPolicy: 'optional-disclosure',
      output: configuration.output,
    },
    capabilities: {
      interactiveInput: true,
      interrupt: true,
      terminate: true,
      resume: false,
      ansiStreaming: configuration.runtime === 'pty',
      structuredOutput: configuration.output === 'json-lines',
      modelSelection: false,
      contextAttachments: true,
      permissionModes: ['plan-read-only', 'worktree-write'],
    },
    suggestedEnvironmentVariables: [],
  });
}
