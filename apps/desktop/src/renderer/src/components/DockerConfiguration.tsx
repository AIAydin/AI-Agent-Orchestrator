import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, RefreshCw } from 'lucide-react';

import type { AppSettings } from '../../../shared/contracts.js';
import type { DockerReadiness, DockerReadinessInput } from '../../../shared/docker-contracts.js';
import { unwrap } from '../lib/ipc.js';
import './DockerConfiguration.css';

type DockerSettings = Pick<
  AppSettings,
  'dockerExecutable' | 'dockerImage' | 'dockerContainerExecutable'
>;

interface DockerConfigurationProps {
  value: DockerSettings;
  onChange(value: DockerSettings): void;
  onReadinessChange?(readiness: DockerReadiness | null): void;
  initialReadiness?: DockerReadiness | null;
  onError(message: string): void;
  compact?: boolean;
  disabled?: boolean;
}

export function DockerConfiguration(props: DockerConfigurationProps) {
  const [readiness, setReadiness] = useState<DockerReadiness | null>(
    props.initialReadiness ?? null,
  );
  const [busy, setBusy] = useState<'check' | 'pull' | 'browse' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const configuration = readinessInput(props.value);

  function update(patch: Partial<DockerSettings>): void {
    const next = { ...props.value, ...patch };
    setReadiness(null);
    setNotice(null);
    props.onReadinessChange?.(null);
    props.onChange(next);
  }

  async function perform(
    operation: 'check' | 'pull' | 'browse',
    action: () => Promise<void>,
  ): Promise<void> {
    setBusy(operation);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'The Docker operation failed.');
    } finally {
      setBusy(null);
    }
  }

  function acceptReadiness(next: DockerReadiness): void {
    setReadiness(next);
    props.onReadinessChange?.(next);
  }

  async function check(): Promise<void> {
    if (configuration === null) return;
    await perform('check', async () => {
      acceptReadiness(unwrap(await window.forgeboard.docker.check(configuration)));
    });
  }

  async function pull(): Promise<void> {
    if (configuration === null) return;
    await perform('pull', async () => {
      const result = unwrap(await window.forgeboard.docker.pull(configuration));
      acceptReadiness(result.readiness);
      setNotice(
        result.outcome === 'cancelled'
          ? 'Image pull cancelled. Nothing was downloaded.'
          : 'Image pull finished and readiness was checked again.',
      );
    });
  }

  async function browse(): Promise<void> {
    await perform('browse', async () => {
      const selected = unwrap(await window.forgeboard.projects.pickExecutable());
      if (selected) update({ dockerExecutable: selected });
    });
  }

  return (
    <div className={`docker-configuration${props.compact ? ' compact' : ''}`}>
      <div className="docker-field-grid">
        <div className="docker-field">
          <label htmlFor="docker-executable">Docker executable</label>
          <span className="path-picker">
            <input
              id="docker-executable"
              name="docker-executable"
              value={props.value.dockerExecutable}
              disabled={props.disabled}
              placeholder="docker"
              onChange={(event) => update({ dockerExecutable: event.target.value })}
            />
            <button
              type="button"
              disabled={props.disabled || busy !== null}
              onClick={() => void browse()}
            >
              Browse
            </button>
          </span>
        </div>
        <label>
          Container image
          <input
            name="docker-container-image"
            value={props.value.dockerImage}
            disabled={props.disabled}
            placeholder="registry.example.com/agent:version"
            onChange={(event) => update({ dockerImage: event.target.value })}
          />
        </label>
        <label>
          Agent executable inside image
          <input
            name="docker-container-agent-executable"
            value={props.value.dockerContainerExecutable}
            disabled={props.disabled}
            placeholder="/usr/local/bin/your-agent"
            onChange={(event) => update({ dockerContainerExecutable: event.target.value })}
          />
        </label>
      </div>

      <p className="docker-explanation">
        The image must already contain this exact agent executable. Forgeboard never assumes a
        general-purpose image includes your selected CLI and never pulls an image automatically.
      </p>

      <div className="docker-readiness-actions">
        <button
          type="button"
          className="button secondary"
          disabled={props.disabled || configuration === null || busy !== null}
          onClick={() => void check()}
        >
          <RefreshCw size={14} className={busy === 'check' ? 'spin' : ''} />
          {busy === 'check' ? 'Checking…' : 'Check Docker'}
        </button>
        <button
          type="button"
          className="button ghost"
          disabled={props.disabled || configuration === null || busy !== null}
          onClick={() => void pull()}
        >
          <Download size={14} /> {busy === 'pull' ? 'Pulling…' : 'Pull image…'}
        </button>
        <small>A native confirmation appears before any registry download.</small>
      </div>

      {configuration === null && (
        <div className="docker-readiness missing" role="status">
          <AlertTriangle size={15} />
          <span>Enter an image and its absolute agent executable path to check readiness.</span>
        </div>
      )}
      {configuration !== null && readiness === null && (
        <div className="docker-readiness missing" role="status">
          <AlertTriangle size={15} />
          <span>
            <strong>Docker profile not verified</strong>
            <small>Use Check Docker before relying on this profile.</small>
          </span>
        </div>
      )}
      {readiness !== null && <DockerReadinessStatus readiness={readiness} />}
      {notice !== null && <small className="docker-notice">{notice}</small>}
    </div>
  );
}

function DockerReadinessStatus({ readiness }: { readiness: DockerReadiness }) {
  return (
    <div className={`docker-readiness ${readiness.available ? 'ready' : 'blocked'}`} role="status">
      {readiness.available ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      <span>
        <strong>{readiness.available ? 'Docker profile ready' : readinessLabel(readiness)}</strong>
        <small>
          {readiness.available
            ? `${readiness.image} contains ${readiness.containerExecutable}; checked ${new Date(readiness.checkedAt).toLocaleTimeString()}.`
            : (readiness.reason ?? 'Docker is not ready with this configuration.')}
        </small>
      </span>
    </div>
  );
}

function readinessInput(value: DockerSettings): DockerReadinessInput | null {
  const dockerExecutable = value.dockerExecutable.trim();
  const image = value.dockerImage.trim();
  const containerExecutable = value.dockerContainerExecutable.trim();
  if (dockerExecutable === '' || image === '' || containerExecutable === '') return null;
  return { dockerExecutable, image, containerExecutable };
}

function readinessLabel(readiness: DockerReadiness): string {
  return {
    'executable-unavailable': 'Docker executable unavailable',
    'daemon-unavailable': 'Docker daemon unavailable',
    'image-missing': 'Image is not stored locally',
    'image-incompatible': 'Image is incompatible',
    'agent-unavailable': 'Agent executable unavailable in image',
    ready: 'Docker profile ready',
  }[readiness.status];
}
