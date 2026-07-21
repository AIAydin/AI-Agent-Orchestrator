import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  AlertTriangle,
  BookOpen,
  FileJson,
  FolderOpen,
  PackagePlus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import type {
  ExtensionDiscoveryView,
  ExtensionInstallPlanView,
  ExtensionSelectionKind,
  InstalledExtensionView,
} from '../../../../shared/application/contracts.js';
import { unwrap } from '../../lib/ipc.js';
import { trapModalFocus } from '../../lib/modal-focus.js';
import { WorkspaceTooltip } from '../workspace/shell/tooltips/WorkspaceTooltip.js';

import './ExtensionSettings.css';

interface ExtensionSettingsProps {
  onError: (message: string) => void;
  onChanged: () => Promise<void>;
}

const PERMISSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'agent.adapter.register': 'Connect an agent tool to Forgeboard.',
  'agent.process.launch': 'Let you start this agent through the normal review-and-approve flow.',
  'agent.context.selected-read': 'Send only the information you choose to an agent run.',
  'agent.provider.network': 'The provider may send the approved information off this device.',
  'canvas.node.register': 'Add new node types to the canvas. They store data only.',
  'canvas.data.persist': 'Save what you type into the extension’s canvas fields on this device.',
};

export function ExtensionSettings({ onError, onChanged }: ExtensionSettingsProps) {
  const [discovery, setDiscovery] = useState<ExtensionDiscoveryView | null>(null);
  const [plan, setPlan] = useState<ExtensionInstallPlanView | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<InstalledExtensionView | null>(null);
  const [removePhrase, setRemovePhrase] = useState('');
  const [expandedDocumentation, setExpandedDocumentation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.forgeboard.extensions
      .list()
      .then((result) => {
        if (active) setDiscovery(unwrap(result));
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const message = errorMessage(cause, 'Forgeboard could not load local extensions.');
        setError(message);
        onError(message);
      });
    return () => {
      active = false;
    };
  }, [onError]);

  async function perform(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (cause) {
      const message = errorMessage(cause, 'The extension action failed. Try again.');
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    await perform(async () => {
      setDiscovery(unwrap(await window.forgeboard.extensions.list()));
    });
  }

  async function choose(kind: ExtensionSelectionKind): Promise<void> {
    await perform(async () => {
      const selectedPlan = unwrap(await window.forgeboard.extensions.choose(kind));
      if (selectedPlan === null) return;
      setReviewed(false);
      setPlan(selectedPlan);
    });
  }

  async function approve(): Promise<void> {
    if (plan === null || !reviewed) return;
    await perform(async () => {
      const next = unwrap(
        await window.forgeboard.extensions.approve({
          planId: plan.planId,
          confirmed: true,
        }),
      );
      setDiscovery(next);
      setPlan(null);
      setReviewed(false);
      await onChanged();
      setNotice(
        `${plan.manifest.name} ${plan.manifest.version} was ${plan.operation === 'install' ? 'installed' : 'updated'}.`,
      );
    });
  }

  async function remove(): Promise<void> {
    if (removeTarget === null) return;
    await perform(async () => {
      const next = unwrap(
        await window.forgeboard.extensions.remove({
          extensionId: removeTarget.manifest.id,
          confirmation: removePhrase,
        }),
      );
      setDiscovery(next);
      setRemoveTarget(null);
      setRemovePhrase('');
      await onChanged();
      setNotice(`${removeTarget.manifest.name} was removed from this device.`);
    });
  }

  return (
    <>
      <section className="settings-section extension-settings-section">
        <header>
          <h3>Local extensions</h3>
          <p>
            Add extensions that connect agents or add canvas items. Just pick a folder or file —
            nothing to configure.
          </p>
        </header>
        <div className="settings-fields">
          <div className="extension-actions">
            <button
              className="button primary"
              type="button"
              disabled={busy}
              onClick={() => void choose('folder')}
            >
              <FolderOpen size={15} aria-hidden="true" /> Choose extension folder
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void choose('manifest')}
            >
              <FileJson size={15} aria-hidden="true" /> Choose extension file
            </button>
            <button
              className="button ghost"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} aria-hidden="true" /> Refresh
            </button>
          </div>
          <div className="extension-safety-note">
            <ShieldCheck size={17} aria-hidden="true" />
            <span>
              <strong>Data-only by design</strong>
              Extension code never runs inside Forgeboard — you approve every install and update.
            </span>
          </div>
          {error && (
            <div className="extension-message error" role="alert">
              <AlertTriangle size={15} aria-hidden="true" /> {error}
            </div>
          )}
          {notice && (
            <div className="extension-message success" role="status">
              <ShieldCheck size={15} aria-hidden="true" /> {notice}
            </div>
          )}
          {discovery === null && !error ? (
            <div className="extension-empty" role="status">
              Loading extensions…
            </div>
          ) : (
            discovery && (
              <>
                <div className="extension-registry-path">
                  <span>Where extensions are stored</span>
                  <code>{discovery.registryPath}</code>
                </div>
                {discovery.installed.length === 0 ? (
                  <div className="extension-empty" role="status">
                    <PackagePlus size={21} aria-hidden="true" />
                    <strong>No extensions installed yet</strong>
                    <span>Choose an extension folder you downloaded to review and install it.</span>
                  </div>
                ) : (
                  <div className="extension-list">
                    {discovery.installed.map((extension) => {
                      const documentationOpen = expandedDocumentation === extension.manifest.id;
                      return (
                        <article className="extension-card" key={extension.manifest.id}>
                          <header>
                            <span className="extension-card-icon">
                              <PackagePlus size={16} aria-hidden="true" />
                            </span>
                            <div>
                              <strong>{extension.manifest.name}</strong>
                              <small>
                                {extension.manifest.id} · v{extension.manifest.version} ·{' '}
                                {extension.manifest.publisher}
                              </small>
                            </div>
                            <span className="status-chip ok">Trusted · active</span>
                          </header>
                          <p>{extension.manifest.description}</p>
                          <ExtensionContributionSummary extension={extension} />
                          <dl className="extension-record-grid">
                            <div>
                              <dt>Manifest fingerprint</dt>
                              <dd>
                                <code>{extension.record.manifestDigest}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Full package fingerprint</dt>
                              <dd>
                                <code>{extension.record.snapshotDigest}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>Folder chosen at install</dt>
                              <dd>
                                <code>{extension.record.sourcePath}</code>
                              </dd>
                            </div>
                          </dl>
                          {extension.documentationText !== undefined && (
                            <>
                              <button
                                className="extension-text-button"
                                type="button"
                                onClick={() =>
                                  setExpandedDocumentation(
                                    documentationOpen ? null : extension.manifest.id,
                                  )
                                }
                              >
                                <BookOpen size={14} aria-hidden="true" />
                                {documentationOpen ? 'Hide documentation' : 'Read documentation'}
                              </button>
                              {documentationOpen && (
                                <pre className="extension-documentation">
                                  {extension.documentationText}
                                </pre>
                              )}
                            </>
                          )}
                          <footer>
                            <button
                              className="button"
                              type="button"
                              disabled={busy}
                              onClick={() => void choose('folder')}
                            >
                              <Upload size={14} aria-hidden="true" /> Update from folder
                            </button>
                            <button
                              className="button ghost extension-remove-trigger"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setRemovePhrase('');
                                setRemoveTarget(extension);
                              }}
                            >
                              <Trash2 size={14} aria-hidden="true" /> Remove
                            </button>
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                )}
                {discovery.quarantined.length > 0 && (
                  <section className="extension-invalid-list extension-quarantine-list">
                    <h4>
                      <AlertTriangle size={15} aria-hidden="true" /> Quarantined extensions
                    </h4>
                    <p>
                      These no longer match what you approved, so they stay turned off until you
                      install or update them again.
                    </p>
                    {discovery.quarantined.map((entry) => (
                      <div key={`${entry.extensionId}:${entry.ledgerState}`}>
                        <strong>
                          {entry.snapshot?.manifest.name ?? entry.extensionId}{' '}
                          <span className="status-chip warning">{entry.ledgerState}</span>
                        </strong>
                        <span>{entry.reason}</span>
                      </div>
                    ))}
                  </section>
                )}
                {discovery.invalid.length > 0 && (
                  <section className="extension-invalid-list">
                    <h4>
                      <AlertTriangle size={15} aria-hidden="true" /> Entries that could not be
                      loaded
                    </h4>
                    <p>Forgeboard skipped these. Each entry shows why.</p>
                    {discovery.invalid.map((entry) => (
                      <div key={entry.entryName}>
                        <strong>{entry.entryName}</strong>
                        <span>{entry.reason}</span>
                      </div>
                    ))}
                  </section>
                )}
              </>
            )
          )}
        </div>
      </section>

      {plan && (
        <ExtensionReviewDialog
          plan={plan}
          busy={busy}
          reviewed={reviewed}
          error={error}
          onReviewedChange={setReviewed}
          onCancel={() => {
            setPlan(null);
            setReviewed(false);
          }}
          onApprove={() => void approve()}
        />
      )}

      {removeTarget && (
        <ExtensionRemoveDialog
          target={removeTarget}
          busy={busy}
          phrase={removePhrase}
          error={error}
          onPhraseChange={setRemovePhrase}
          onCancel={() => {
            setRemoveTarget(null);
            setRemovePhrase('');
          }}
          onRemove={() => void remove()}
        />
      )}
    </>
  );
}

function useExtensionDialogFocus(
  dialog: RefObject<HTMLElement | null>,
  initialFocus: RefObject<HTMLElement | null>,
  busy: boolean,
  onCancel: () => void,
): void {
  const cancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  cancelRef.current = onCancel;
  busyRef.current = busy;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus.current ?? dialog.current)?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      const openDialogs = [
        ...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'),
      ];
      if (openDialogs.at(-1) !== dialog.current) return;
      trapModalFocus(event, dialog.current);
      if (event.key !== 'Escape' || busyRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelRef.current();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [dialog, initialFocus]);

  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy, dialog]);
}

function ExtensionReviewDialog({
  plan,
  busy,
  reviewed,
  error,
  onReviewedChange,
  onCancel,
  onApprove,
}: {
  plan: ExtensionInstallPlanView;
  busy: boolean;
  reviewed: boolean;
  error: string | null;
  onReviewedChange: (reviewed: boolean) => void;
  onCancel: () => void;
  onApprove: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useExtensionDialogFocus(dialog, closeButton, busy, onCancel);

  return (
    <div className="modal-backdrop extension-review-backdrop" role="presentation">
      <section
        ref={dialog}
        className="extension-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-review-title"
        aria-describedby="extension-review-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <span className="modal-title-icon">
            <ShieldCheck size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 id="extension-review-title">
              {plan.operation === 'install'
                ? 'Review extension install'
                : 'Review extension update'}
            </h2>
            <p id="extension-review-description">
              This approval applies only to the exact version and permissions shown below.
            </p>
          </div>
          <WorkspaceTooltip
            content={busy ? 'Wait for the extension action to finish' : 'Cancel extension review'}
          >
            <button
              ref={closeButton}
              className="icon-button"
              type="button"
              disabled={busy}
              aria-label="Cancel extension review"
              onClick={onCancel}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </WorkspaceTooltip>
        </header>
        <div className="extension-review-content">
          <div className="extension-plan-title">
            <strong>{plan.manifest.name}</strong>
            <span>
              {plan.manifest.id} · {plan.manifest.version} · {plan.manifest.publisher}
            </span>
            <p>{plan.manifest.description}</p>
          </div>
          {plan.operation === 'update' && (
            <div className="extension-update-path">
              Update <strong>{plan.currentVersion}</strong> →{' '}
              <strong>{plan.manifest.version}</strong>
            </div>
          )}
          <dl className="extension-plan-facts">
            <div>
              <dt>Manifest fingerprint (SHA-256)</dt>
              <dd>
                <code>{plan.manifestDigest}</code>
              </dd>
            </div>
            <div>
              <dt>Full package fingerprint (SHA-256)</dt>
              <dd>
                <code>{plan.snapshotDigest}</code>
              </dd>
            </div>
            <div>
              <dt>Selected folder or file</dt>
              <dd>
                <code>{plan.sourcePath}</code>
              </dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>{new Date(plan.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          <section className="extension-review-section">
            <h3>Requested permissions</h3>
            <div className="extension-permission-list">
              {plan.requestedPermissions.map((permission) => (
                <div key={permission}>
                  <ShieldCheck size={14} aria-hidden="true" />
                  <span>
                    <code>{permission}</code>
                    <small>{PERMISSION_DESCRIPTIONS[permission] ?? permission}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
          <section className="extension-review-section">
            <h3>What this extension adds</h3>
            <PlanContributionSummary plan={plan} />
            <details>
              <summary>Show full technical details</summary>
              <pre>{plan.manifestJson}</pre>
            </details>
          </section>
          {plan.documentationText !== undefined && (
            <section className="extension-review-section">
              <h3>Extension documentation</h3>
              <pre className="extension-documentation">{plan.documentationText}</pre>
            </section>
          )}
          <label className="extension-review-confirmation">
            <input
              type="checkbox"
              name="extension-manifest-reviewed"
              checked={reviewed}
              onChange={(event) => onReviewedChange(event.target.checked)}
            />
            <span>
              <strong>I reviewed these exact details and permissions</strong>
              <small>
                Nothing installs yet — your system confirmation is still required, and text inside
                the package can’t grant approval by itself.
              </small>
            </span>
          </label>
        </div>
        {error && (
          <div className="extension-message error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" /> {error}
          </div>
        )}
        <footer>
          <button className="button ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || !reviewed}
            onClick={onApprove}
          >
            <ShieldCheck size={15} aria-hidden="true" />
            {plan.operation === 'install' ? 'Continue to confirmation' : 'Confirm update'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ExtensionRemoveDialog({
  target,
  busy,
  phrase,
  error,
  onPhraseChange,
  onCancel,
  onRemove,
}: {
  target: InstalledExtensionView;
  busy: boolean;
  phrase: string;
  error: string | null;
  onPhraseChange: (phrase: string) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);
  useExtensionDialogFocus(dialog, confirmInput, busy, onCancel);

  return (
    <div className="modal-backdrop extension-review-backdrop" role="presentation">
      <section
        ref={dialog}
        className="extension-remove-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-remove-title"
        aria-describedby="extension-remove-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <header>
          <span className="modal-title-icon danger-icon">
            <Trash2 size={19} aria-hidden="true" />
          </span>
          <div>
            <h2 id="extension-remove-title">Remove {target.manifest.name}?</h2>
            <p id="extension-remove-description">
              The folder you downloaded stays on this device. A final system confirmation follows,
              with Cancel pre-selected.
            </p>
          </div>
        </header>
        <label>
          Type <strong>{target.manifest.id}</strong> to confirm
          <input
            ref={confirmInput}
            name={`extension-remove-${encodeURIComponent(target.manifest.id)}`}
            value={phrase}
            onChange={(event) => onPhraseChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
        </label>
        {error && (
          <div className="extension-message error" role="alert">
            <AlertTriangle size={15} aria-hidden="true" /> {error}
          </div>
        )}
        <footer>
          <button className="button ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button danger"
            type="button"
            disabled={busy || phrase !== target.manifest.id}
            onClick={onRemove}
          >
            <Trash2 size={15} aria-hidden="true" /> Continue to confirmation
          </button>
        </footer>
      </section>
    </div>
  );
}

function ExtensionContributionSummary({ extension }: { extension: InstalledExtensionView }) {
  return (
    <div className="extension-contribution-chips">
      <span>{extension.manifest.contributes.agentAdapters.length} agent tools</span>
      <span>{extension.manifest.contributes.canvasNodeTypes.length} canvas items</span>
      <span>{extension.record.grantedPermissions.length} permissions</span>
    </div>
  );
}

function PlanContributionSummary({ plan }: { plan: ExtensionInstallPlanView }) {
  return (
    <div className="extension-contribution-list">
      {plan.manifest.contributes.agentAdapters.map((adapter) => (
        <div key={adapter.id}>
          <strong>Agent tool · {adapter.name}</strong>
          <span>
            <code>{adapter.id}</code> · provider {adapter.providerName} · program{' '}
            <code>{adapter.executable}</code>
          </span>
          <small>{adapter.providerDisclosure}</small>
        </div>
      ))}
      {plan.manifest.contributes.canvasNodeTypes.map((nodeType) => (
        <div key={nodeType.id}>
          <strong>Canvas item · {nodeType.displayName}</strong>
          <span>
            <code>{nodeType.id}</code> · {nodeType.category} · {nodeType.fields.length} fields ·{' '}
            {nodeType.ports.length} connection points
          </span>
          <small>{nodeType.description}</small>
        </div>
      ))}
    </div>
  );
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}
