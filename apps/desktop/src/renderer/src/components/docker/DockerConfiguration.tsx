import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, RefreshCw } from 'lucide-react';

import type { AppSettings } from '../../../../shared/application/contracts.js';
import {
  DEFAULT_DOCKER_SESSION_CONTAINER_EXECUTABLE,
  DEFAULT_DOCKER_SESSION_IMAGE,
  type DockerLocalList,
  type DockerReadiness,
} from '../../../../shared/docker/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import {
  dockerEvidenceBelongsTo,
  dockerReadinessRequest,
  dockerRequestsMatch,
  type DockerReadinessEvidence,
} from './readiness-evidence.js';
import './DockerConfiguration.css';

type DockerSettings = Pick<
  AppSettings,
  'dockerExecutable' | 'dockerImage' | 'dockerContainerExecutable'
>;

interface DockerConfigurationProps {
  value: DockerSettings;
  onChange(value: DockerSettings): void;
  onReadinessChange?(evidence: DockerReadinessEvidence | null): void;
  initialReadiness?: DockerReadinessEvidence | null;
  onError(message: string): void;
  compact?: boolean;
  disabled?: boolean;
}

export function DockerConfiguration(props: DockerConfigurationProps) {
  const [evidence, setEvidence] = useState<DockerReadinessEvidence | null>(
    props.initialReadiness ?? null,
  );
  const [busy, setBusy] = useState<'check' | 'pull' | 'browse' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [localList, setLocalList] = useState<DockerLocalList | null>(null);
  const [syncAttempt, setSyncAttempt] = useState(0);
  const configuration = dockerReadinessRequest(props.value);
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const currentEvidence = dockerEvidenceBelongsTo(props.value, evidence) ? evidence : null;

  // Keep the image picker synced with the local Docker daemon. Listing is read-only, so a
  // missing daemon just leaves the picker with the default image and the saved value.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.forgeboard.docker.listLocal?.({
          dockerExecutable: props.value.dockerExecutable.trim() || 'docker',
        });
        if (!cancelled && result?.ok === true) setLocalList(result.value);
      } catch {
        // The picker still offers the default image when Docker cannot be reached.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.value.dockerExecutable, syncAttempt]);

  useEffect(() => {
    setEvidence(props.initialReadiness ?? null);
    setNotice(null);
  }, [props.initialReadiness]);

  useEffect(() => {
    setEvidence(null);
    setNotice(null);
    props.onReadinessChange?.(null);
  }, [
    props.value.dockerExecutable,
    props.value.dockerImage,
    props.value.dockerContainerExecutable,
  ]);

  function update(patch: Partial<DockerSettings>): void {
    const next = { ...props.value, ...patch };
    setEvidence(null);
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
      props.onError(
        error instanceof Error ? error.message : 'The Docker action failed. Try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  function clearReadiness(): void {
    setEvidence(null);
    props.onReadinessChange?.(null);
  }

  function acceptReadiness(
    request: NonNullable<typeof configuration>,
    next: DockerReadiness,
  ): void {
    const current = configurationRef.current;
    if (current === null || !dockerRequestsMatch(request, current)) return;
    const accepted = { request, readiness: next } satisfies DockerReadinessEvidence;
    setEvidence(accepted);
    props.onReadinessChange?.(accepted);
  }

  async function check(): Promise<void> {
    if (configuration === null) return;
    const request = configuration;
    clearReadiness();
    await perform('check', async () => {
      const checked = unwrap(await window.forgeboard.docker.check(request));
      if (checked === null) {
        setNotice('Check cancelled — nothing was run.');
        return;
      }
      acceptReadiness(request, checked);
    });
  }

  /** The create action: select the default image (git + Node) and pull it after confirmation. */
  async function getDefaultImage(): Promise<void> {
    const nextValue = {
      ...props.value,
      dockerImage: DEFAULT_DOCKER_SESSION_IMAGE,
      dockerContainerExecutable:
        props.value.dockerContainerExecutable.trim() === ''
          ? DEFAULT_DOCKER_SESSION_CONTAINER_EXECUTABLE
          : props.value.dockerContainerExecutable,
    };
    const request = dockerReadinessRequest(nextValue);
    if (request === null) return;
    update({
      dockerImage: nextValue.dockerImage,
      dockerContainerExecutable: nextValue.dockerContainerExecutable,
    });
    await perform('pull', async () => {
      const result = unwrap(await window.forgeboard.docker.pull(request));
      if (result.readiness !== null) acceptReadiness(request, result.readiness);
      setNotice(
        result.outcome === 'cancelled'
          ? 'Download cancelled — nothing was downloaded.'
          : 'Default image ready.',
      );
      setSyncAttempt((count) => count + 1);
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
              disabled={props.disabled || busy !== null}
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
        <div className="docker-field">
          <label htmlFor="docker-container-image">Container image</label>
          <span className="path-picker">
            <select
              id="docker-container-image"
              name="docker-container-image"
              value={props.value.dockerImage}
              disabled={props.disabled || busy !== null}
              onChange={(event) =>
                update({
                  dockerImage: event.target.value,
                  ...(event.target.value === DEFAULT_DOCKER_SESSION_IMAGE &&
                  props.value.dockerContainerExecutable.trim() === ''
                    ? { dockerContainerExecutable: DEFAULT_DOCKER_SESSION_CONTAINER_EXECUTABLE }
                    : {}),
                })
              }
            >
              {imageOptions(props.value.dockerImage.trim(), localList)}
            </select>
            <button
              type="button"
              aria-label="Sync images from Docker"
              disabled={props.disabled || busy !== null}
              onClick={() => setSyncAttempt((count) => count + 1)}
            >
              Sync
            </button>
          </span>
        </div>
        <label>
          Agent executable inside image
          <input
            name="docker-container-agent-executable"
            value={props.value.dockerContainerExecutable}
            disabled={props.disabled || busy !== null}
            placeholder="/usr/local/bin/your-agent"
            onChange={(event) => update({ dockerContainerExecutable: event.target.value })}
          />
        </label>
      </div>

      <p className="docker-explanation">
        Images are synced from your local Docker. The default image ships git and Node and runs
        agents with npx.
      </p>
      {localList !== null && !localList.daemonAvailable && (
        <small className="docker-notice">{localList.reason ?? 'Docker is not running.'}</small>
      )}

      <div className="docker-readiness-actions">
        <button
          type="button"
          className="button secondary"
          disabled={props.disabled || configuration === null || busy !== null}
          onClick={() => void check()}
        >
          <RefreshCw size={14} className={busy === 'check' ? 'spin' : ''} aria-hidden="true" />
          {busy === 'check' ? 'Checking…' : 'Check Docker'}
        </button>
        <button
          type="button"
          className="button ghost"
          disabled={props.disabled || busy !== null}
          onClick={() => void getDefaultImage()}
        >
          <Download size={14} aria-hidden="true" />{' '}
          {busy === 'pull' ? 'Downloading…' : 'Get default image'}
        </button>
        <small>You will be asked to confirm before anything is downloaded.</small>
      </div>

      {configuration === null && (
        <div className="docker-readiness missing" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>Pick an image, or get the default one, then run the check.</span>
        </div>
      )}
      {configuration !== null && currentEvidence === null && (
        <div className="docker-readiness missing" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            <strong>Docker profile not checked yet</strong>
            <small>Run “Check Docker” before relying on this profile.</small>
          </span>
        </div>
      )}
      {currentEvidence !== null && <DockerReadinessStatus readiness={currentEvidence.readiness} />}
      {notice !== null && <small className="docker-notice">{notice}</small>}
    </div>
  );
}

/**
 * Select options for the image picker: everything local Docker knows (images, then containers by
 * their image), plus the default image and the saved value so the select never loses state.
 */
function imageOptions(currentImage: string, localList: DockerLocalList | null) {
  const images = localList?.images ?? [];
  const containers = localList?.containers ?? [];
  const known = new Set(images.map((image) => image.reference));
  return (
    <>
      {currentImage === '' && (
        <option value="" disabled hidden>
          Choose an image…
        </option>
      )}
      {currentImage !== '' &&
        currentImage !== DEFAULT_DOCKER_SESSION_IMAGE &&
        !known.has(currentImage) && <option value={currentImage}>{currentImage}</option>}
      {!known.has(DEFAULT_DOCKER_SESSION_IMAGE) && (
        <option value={DEFAULT_DOCKER_SESSION_IMAGE}>
          {DEFAULT_DOCKER_SESSION_IMAGE} — default
        </option>
      )}
      {images.map((image) => (
        <option key={image.reference} value={image.reference}>
          {image.reference === DEFAULT_DOCKER_SESSION_IMAGE
            ? `${image.reference} — default`
            : image.reference}
        </option>
      ))}
      {containers.length > 0 && (
        <optgroup label="Containers">
          {containers.map((container) => (
            <option key={`container-${container.name}`} value={container.image}>
              {container.name} — {container.image}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

function DockerReadinessStatus({ readiness }: { readiness: DockerReadiness }) {
  return (
    <div className={`docker-readiness ${readiness.available ? 'ready' : 'blocked'}`} role="status">
      {readiness.available ? (
        <CheckCircle2 size={16} aria-hidden="true" />
      ) : (
        <AlertTriangle size={16} aria-hidden="true" />
      )}
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

function readinessLabel(readiness: DockerReadiness): string {
  return {
    'executable-unavailable': 'Docker program not found',
    'daemon-unavailable': 'Docker is not running',
    'image-missing': 'Image is not stored locally',
    'image-incompatible': 'Image does not work with this setup',
    'agent-unavailable': 'Agent program not found in the image',
    ready: 'Docker profile ready',
  }[readiness.status];
}
