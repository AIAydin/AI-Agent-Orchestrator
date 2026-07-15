import path from 'node:path';

import type { DockerReadinessInput } from '../../shared/docker/contracts.js';
import type { OutboundActionDisclosure } from './outbound-action-gate.js';

const URL_TRANSPORTS = new Set(['file:', 'git:', 'http:', 'https:', 'ssh:']);

export function dockerPullDisclosure(
  input: DockerReadinessInput,
  resolvedExecutable: string,
): OutboundActionDisclosure {
  const components = input.image.split('/');
  const first = components[0] ?? '';
  const explicitRegistry =
    components.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const endpoint = explicitRegistry ? first : 'registry-1.docker.io';
  return {
    action: 'docker-image-pull',
    title: 'Pull Docker image',
    summary: `Allow Docker to pull ${input.image}?`,
    confirmLabel: 'Pull image',
    destination: {
      kind: 'container-registry',
      endpoint,
      resource: input.image,
      transport: 'Docker Registry API',
    },
    details: [
      { label: 'Docker executable', value: resolvedExecutable },
      { label: 'Expected container executable', value: input.containerExecutable },
    ],
    warning:
      'The Docker daemon may contact registry authentication and storage endpoints associated with this exact image reference. Forgeboard does not mount host folders, credentials, keychains, or control sockets into the downloaded image.',
  };
}

export function gitCloneDisclosure(
  remoteUrl: string,
  destinationPath: string,
): OutboundActionDisclosure {
  const remote = parseGitRemote(remoteUrl);
  return {
    action: 'git-clone',
    title: 'Clone Git repository',
    summary: `Allow Git to clone ${remote.resource}?`,
    confirmLabel: 'Clone repository',
    destination: {
      kind: 'git-remote',
      endpoint: remote.endpoint,
      resource: remote.resource,
      transport: remote.transport,
    },
    details: [{ label: 'Local destination', value: path.resolve(destinationPath) }],
    warning:
      remote.endpoint === 'local-filesystem'
        ? 'This source is local. Forgeboard still requires the same per-use approval because cloning creates repository content at the disclosed destination.'
        : 'Git may use your existing operating-system or Git credential helper. Forgeboard does not store credentials, and remote URLs containing credentials are rejected.',
  };
}

interface ParsedGitRemote {
  readonly endpoint: string;
  readonly resource: string;
  readonly transport: string;
}

function parseGitRemote(value: string): ParsedGitRemote {
  const remote = value.trim();
  if (remote === '' || remote.length > 2_048 || remote.includes('\0') || /[\r\n]/u.test(remote)) {
    throw new Error('Git clone remotes must be bounded single-line values.');
  }
  if (remote.startsWith('-') || remote.startsWith('ext::')) {
    throw new Error('This Git clone transport is not supported.');
  }

  const scp = /^(?:([^@/:\s]+)@)?([^:/\s]+):(.+)$/u.exec(remote);
  if (scp !== null && !remote.includes('://')) {
    const account = scp[1];
    const host = scp[2] ?? '';
    const resource = scp[3] ?? '';
    if (host === '' || resource === '' || resource.includes('\0')) {
      throw new Error('The SSH Git remote is incomplete.');
    }
    return {
      endpoint: host,
      resource: account === undefined ? resource : `${account}@${host}:${resource}`,
      transport: 'SSH',
    };
  }

  if (!remote.includes('://')) {
    return {
      endpoint: 'local-filesystem',
      resource: path.resolve(remote),
      transport: 'Local file access',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch (error) {
    throw new Error('The Git clone remote is not a valid supported URL.', { cause: error });
  }
  if (!URL_TRANSPORTS.has(parsed.protocol)) {
    throw new Error('Only file, Git, HTTP(S), and SSH clone transports are supported.');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'Remote URLs containing credentials, query values, or fragments are not accepted. Use an authenticated Git credential helper or SSH agent.',
    );
  }
  if (parsed.protocol === 'file:') {
    return {
      endpoint: 'local-filesystem',
      resource: parsed.pathname,
      transport: 'Local file access',
    };
  }
  if (parsed.hostname === '') throw new Error('The Git clone remote has no hostname.');
  return {
    endpoint: parsed.port === '' ? parsed.hostname : `${parsed.hostname}:${parsed.port}`,
    resource: parsed.pathname,
    transport: parsed.protocol.slice(0, -1).toUpperCase(),
  };
}
