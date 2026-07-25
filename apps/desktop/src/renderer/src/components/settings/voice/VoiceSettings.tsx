import { Download, Mic, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { VoiceModelStatus } from '../../../../../shared/voice/contracts.js';
import { unwrap } from '../../../lib/ipc.js';
import { SettingsSection, type AsyncSettingsProps } from '../shared.js';

export function VoiceSettings({ draft, setDraft, busy, perform }: AsyncSettingsProps) {
  const [model, setModel] = useState<VoiceModelStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void window.forgeboard.voice
      .status()
      .then(unwrap)
      .then((status) => active && setModel(status))
      .catch((error: unknown) => {
        if (active) setMessage(error instanceof Error ? error.message : 'Model status failed.');
      });
    return () => {
      active = false;
    };
  }, []);

  async function install(): Promise<void> {
    setMessage(null);
    await perform(async () => {
      const status = unwrap(await window.forgeboard.voice.install());
      setModel(status);
      setMessage(
        status.state === 'ready'
          ? 'The voice model is installed. Transcription now stays on this device.'
          : 'The model download was cancelled.',
      );
    });
  }

  async function remove(): Promise<void> {
    setMessage(null);
    await perform(async () => {
      const status = unwrap(await window.forgeboard.voice.remove());
      setModel(status);
      if (status.state === 'not-installed') {
        setDraft((current) => ({ ...current, voiceCommandsEnabled: false }));
        setMessage('The local voice model was removed. Save settings to keep voice disabled.');
      } else {
        setMessage('Model removal was cancelled.');
      }
    });
  }

  const ready = model?.state === 'ready';
  return (
    <SettingsSection
      title="Local voice commands"
      description="Record a command, transcribe it locally with Whisper, and run the closest registered action right away. Audio and transcripts are not saved."
    >
      <div className="info-path">
        <span>
          <Mic size={16} aria-hidden="true" />
        </span>
        <div>
          <strong>Whisper Tiny English</strong>
          <code>{modelStatusLabel(model)}</code>
        </div>
      </div>

      <div className="button-row">
        {!ready ? (
          <button className="button" type="button" disabled={busy} onClick={() => void install()}>
            <Download size={14} aria-hidden="true" /> Install local model
          </button>
        ) : (
          <button
            className="button ghost"
            type="button"
            disabled={busy}
            onClick={() => void remove()}
          >
            <Trash2 size={14} aria-hidden="true" /> Remove model
          </button>
        )}
      </div>

      <label className="switch-row">
        <span>
          <strong>Enable voice commands</strong>
          <small>
            Mic access stays in the main window. Commands run right after transcription;
            destructive actions still ask.
          </small>
        </span>
        <input
          type="checkbox"
          name="voice-commands-enabled"
          checked={draft.voiceCommandsEnabled}
          disabled={busy || !ready}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              voiceCommandsEnabled: event.target.checked,
            }))
          }
        />
      </label>

      <p className="recovery-guidance">
        The one-time model install contacts Hugging Face only after a native approval. Once
        installed, Forgeboard disables remote model loading and performs transcription offline.
      </p>
      {message && <p role="status">{message}</p>}
    </SettingsSection>
  );
}

function modelStatusLabel(status: VoiceModelStatus | null): string {
  if (status === null) return 'Checking local model…';
  if (status.state === 'ready') return 'Installed · local only';
  if (status.state === 'installing') return 'Installing…';
  if (status.state === 'loading') return 'Loading locally…';
  if (status.state === 'error') return status.detail ?? 'Model needs attention';
  return 'Not installed';
}
