import { CliAgentAdapter } from '@forgeboard/agent-adapters';
import { describe, expect, it } from 'vitest';

import { CustomAgentConfigurationSchema } from '../../shared/application/contracts.js';
import { customAgentManifest } from './custom-agent.js';

describe('Settings-owned custom CLI adapter', () => {
  it('turns bounded UI fields into a validated argument-transport manifest', () => {
    const manifest = customAgentManifest(
      CustomAgentConfigurationSchema.parse({
        enabled: true,
        name: 'Local helper',
        providerName: 'Local process',
        providerDisclosure: 'This command receives only the context shown before launch.',
        sendsContextOffDevice: false,
        executable: process.execPath,
        versionArguments: ['--version'],
        launchArguments: ['helper.mjs', '--request'],
        promptTransport: 'argument',
        runtime: 'pipes',
        output: 'json-lines',
      }),
    );

    expect(manifest).toMatchObject({
      id: 'custom',
      executable: { command: process.execPath },
      invocation: {
        launchArguments: ['helper.mjs', '--request', '{prompt}', '{extraArgs}'],
        promptTransport: 'argument',
      },
      capabilities: { structuredOutput: true, modelSelection: false },
    });
  });

  it('rejects an adapter that is not explicitly enabled', () => {
    expect(() => customAgentManifest(CustomAgentConfigurationSchema.parse({}))).toThrow(
      /configure and enable/iu,
    );
  });

  it('launches the UI-built custom adapter without a manifest file', async () => {
    const manifest = customAgentManifest(
      CustomAgentConfigurationSchema.parse({
        enabled: true,
        name: 'Argument echo',
        providerName: 'Local fixture',
        providerDisclosure: 'This fixture stays on device.',
        sendsContextOffDevice: false,
        executable: process.execPath,
        launchArguments: ['-e', 'process.stdout.write(process.argv[1] ?? "")'],
        promptTransport: 'argument',
        runtime: 'pipes',
        output: 'text',
      }),
    );
    const adapter = new CliAgentAdapter(manifest);
    const plan = adapter.prepareLaunch({
      prompt: 'custom-cli-prompt',
      cwd: process.cwd(),
      permissionProfile: {
        id: 'custom-cli-test',
        name: 'Read-only test',
        mode: 'plan-read-only',
        enforcement: 'disclosure-only',
        readRoots: [process.cwd()],
        writeRoots: [],
        network: 'blocked',
        approvalPolicy: 'The test approves this exact local fixture.',
        disclosure: 'The fixture cannot write project files.',
      },
      contextAttachments: [],
      environment: { inherit: 'none', variables: {}, unset: [] },
    });

    const session = await adapter.launch(plan);
    const output: string[] = [];
    const consume = (async () => {
      for await (const event of session.events) {
        if (event.type === 'stream') output.push(event.data);
      }
    })();
    await expect(session.result).resolves.toMatchObject({ status: 'succeeded', exitCode: 0 });
    await consume;
    expect(output.join('')).toContain('custom-cli-prompt');
  });
});
