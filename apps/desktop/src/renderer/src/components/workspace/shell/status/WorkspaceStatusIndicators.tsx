import { Cloud, CloudOff, GitBranch, ShieldCheck } from 'lucide-react';

import type { AgentDetection, Project } from '../../../../../../shared/application/contracts.js';
import type { CollaborationConnectionStatus } from '../../../../../../shared/collaboration/index.js';
import { WorkspaceTooltip } from '../tooltips/WorkspaceTooltip.js';
import './workspace-status-indicators.css';

export type WorkspaceSharingStatus = CollaborationConnectionStatus | 'not-connected';

export function WorkspaceStatusIndicators({
  project,
  projectStatusAvailable,
  agents,
  collaborationEnabled,
  sharingStatus,
}: {
  project: Project;
  projectStatusAvailable: boolean;
  agents: readonly AgentDetection[];
  collaborationEnabled: boolean;
  sharingStatus: WorkspaceSharingStatus;
}) {
  const providerDisclosures = agents
    .filter((agent) => agent.installed && isCodingAgent(agent.id))
    .map((agent) => `${agent.label}: ${agent.providerDisclosure}`);
  const externalProviderAvailable = agents.some(
    (agent) => agent.installed && isExternalCodingAgent(agent.id),
  );
  const branch = project.health.branch;
  const SharingIcon = collaborationEnabled && sharingStatus === 'connected' ? Cloud : CloudOff;

  return (
    <div className="workspace-status-indicators" role="group" aria-label="Workspace status">
      <WorkspaceTooltip content={sharingTitle(collaborationEnabled, sharingStatus)}>
        <span
          className={`workspace-status-chip sharing-${collaborationEnabled ? sharingStatus : 'solo'}`}
          role="status"
          aria-label={sharingLabel(collaborationEnabled, sharingStatus)}
          tabIndex={0}
        >
          <SharingIcon size={11} aria-hidden="true" />
          {sharingLabel(collaborationEnabled, sharingStatus)}
        </span>
      </WorkspaceTooltip>
      <details className="workspace-provider-status">
        <summary className="workspace-status-chip">
          <ShieldCheck size={11} aria-hidden="true" />
          {externalProviderAvailable
            ? 'Providers · approved context only'
            : 'Agents · local demo only'}
        </summary>
        <div className="workspace-provider-disclosure" role="note">
          {providerDisclosures.length === 0 ? (
            <p>The deterministic test agent stays on this device.</p>
          ) : (
            providerDisclosures.map((disclosure) => <p key={disclosure}>{disclosure}</p>)
          )}
        </div>
      </details>
      <WorkspaceTooltip
        content={
          !projectStatusAvailable
            ? 'Forgeboard could not verify this project folder or its current Git state.'
            : branch === null
              ? 'This project is not a Git repository.'
              : `${project.health.dirty ? 'Uncommitted changes on' : 'Current branch'} ${branch}`
        }
      >
        <span
          className={`workspace-status-chip${projectStatusAvailable && project.health.dirty ? ' dirty' : ''}`}
          role="status"
          aria-label={
            !projectStatusAvailable
              ? 'Git status unavailable'
              : branch === null
                ? 'No Git branch'
                : `${branch}${project.health.dirty ? ' · modified' : ''}`
          }
          tabIndex={0}
        >
          <GitBranch size={11} aria-hidden="true" />
          {!projectStatusAvailable
            ? 'Git status unavailable'
            : branch === null
              ? 'No Git branch'
              : `${branch}${project.health.dirty ? ' · modified' : ''}`}
        </span>
      </WorkspaceTooltip>
    </div>
  );
}

function isCodingAgent(id: AgentDetection['id']): boolean {
  return id !== 'gh' && id !== 'docker';
}

function isExternalCodingAgent(id: AgentDetection['id']): boolean {
  return isCodingAgent(id) && id !== 'test-agent';
}

function sharingLabel(enabled: boolean, status: WorkspaceSharingStatus): string {
  if (!enabled) return 'Solo · local only';
  if (status === 'connected') return 'Sharing · connected';
  if (status === 'connecting' || status === 'reconnecting') return 'Sharing · reconnecting';
  if (status === 'disconnecting') return 'Sharing · disconnecting';
  if (status === 'error') return 'Sharing · error';
  return 'Sharing · offline';
}

function sharingTitle(enabled: boolean, status: WorkspaceSharingStatus): string {
  if (!enabled) return 'Solo mode is local and does not contact a collaboration server.';
  if (status === 'connected') return 'Canvas metadata sharing is connected.';
  if (status === 'not-connected') return 'Collaboration is enabled but no room is connected.';
  return `Canvas metadata sharing is ${status}. Local work remains on this device.`;
}
