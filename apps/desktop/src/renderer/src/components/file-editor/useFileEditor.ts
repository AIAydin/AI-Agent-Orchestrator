import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  FileDocumentSchema,
  FileDomainErrorCodeSchema,
  type FileDocument,
  type FileDomainErrorCode,
} from '../../../../shared/files/contracts.js';
import type { FileEditorOperations } from './operations.js';

const MAX_SESSION_HISTORY = 20;

export interface FileHistoryEntry {
  readonly id: string;
  readonly content: string;
  readonly label: string;
  readonly capturedAt: string;
  readonly sha256: string | null;
}

export type FileEditorStatus = 'loading' | 'ready' | 'missing' | 'error';
type FileEditorActivity = 'save' | 'revert' | 'reveal' | 'external' | null;

export interface UseFileEditorResult {
  readonly status: FileEditorStatus;
  readonly activity: FileEditorActivity;
  readonly document: FileDocument | null;
  readonly buffer: string;
  readonly dirty: boolean;
  readonly history: readonly FileHistoryEntry[];
  readonly message: { readonly kind: 'error' | 'success'; readonly text: string } | null;
  readonly setBuffer: (value: string) => void;
  readonly retry: () => void;
  readonly save: () => Promise<void>;
  readonly revert: () => Promise<void>;
  readonly reveal: () => Promise<void>;
  readonly openExternal: () => Promise<void>;
  readonly restoreHistory: (entryId: string) => void;
}

export function useFileEditor(
  projectId: string,
  relativePath: string,
  operations: FileEditorOperations,
  readOnly = false,
): UseFileEditorResult {
  const targetKey = `${projectId}:${relativePath}`;
  const targetKeyRef = useRef(targetKey);
  const requestVersionRef = useRef(0);
  const historySequenceRef = useRef(0);
  const [reloadSequence, setReloadSequence] = useState(0);
  const [status, setStatus] = useState<FileEditorStatus>('loading');
  const [activity, setActivity] = useState<FileEditorActivity>(null);
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [buffer, setBuffer] = useState('');
  const [history, setHistory] = useState<readonly FileHistoryEntry[]>([]);
  const [message, setMessage] = useState<UseFileEditorResult['message']>(null);
  targetKeyRef.current = targetKey;

  const addHistory = useCallback(
    (content: string, label: string, sha256: string | null) => {
      historySequenceRef.current += 1;
      const entry: FileHistoryEntry = {
        id: `${targetKey}:${historySequenceRef.current}`,
        content,
        label,
        capturedAt: new Date().toISOString(),
        sha256,
      };
      setHistory((current) => {
        const withoutDuplicate = current.filter(
          (candidate) => candidate.content !== content || candidate.sha256 !== sha256,
        );
        return [entry, ...withoutDuplicate].slice(0, MAX_SESSION_HISTORY);
      });
    },
    [targetKey],
  );

  const applyDocument = useCallback(
    (candidate: unknown, label: string): FileDocument => {
      const next = FileDocumentSchema.parse(candidate);
      if (next.projectId !== projectId || next.relativePath !== relativePath) {
        throw new Error('The file operation returned a response for a different target.');
      }
      setDocument(next);
      setBuffer(next.content ?? '');
      setStatus('ready');
      if (next.contentKind === 'text' && next.content !== null) {
        addHistory(next.content, label, next.sha256);
      }
      return next;
    },
    [addHistory, projectId, relativePath],
  );

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    setStatus('loading');
    setActivity(null);
    setDocument(null);
    setBuffer('');
    setHistory([]);
    setMessage(null);
    void operations
      .read({ projectId, relativePath })
      .then((next) => {
        if (requestVersionRef.current !== requestVersion) return;
        applyDocument(next, 'Opened file');
      })
      .catch((cause: unknown) => {
        if (requestVersionRef.current !== requestVersion) return;
        const failure = operationFailure(cause, "Artemis couldn't open this file. Try again.");
        setStatus(failure.code === 'FILE_NOT_FOUND' ? 'missing' : 'error');
        setMessage({ kind: 'error', text: failure.message });
      });
    return () => {
      requestVersionRef.current += 1;
    };
  }, [applyDocument, operations, projectId, relativePath, reloadSequence]);

  const dirty = useMemo(
    () => document?.contentKind === 'text' && buffer !== document.content,
    [buffer, document],
  );

  const retry = useCallback(() => setReloadSequence((value) => value + 1), []);

  const setEditableBuffer = useCallback(
    (value: string) => {
      if (readOnly || document?.readOnly === true) return;
      setBuffer(value);
    },
    [document?.readOnly, readOnly],
  );

  const save = useCallback(async () => {
    if (
      readOnly ||
      document?.readOnly === true ||
      !dirty ||
      document?.contentKind !== 'text' ||
      document.sha256 === null
    ) {
      return;
    }
    const operationTarget = targetKey;
    setActivity('save');
    setMessage(null);
    try {
      const next = await operations.save({
        projectId,
        relativePath,
        content: buffer,
        expectedSha256: document.sha256,
      });
      if (targetKeyRef.current !== operationTarget) return;
      applyDocument(next, 'Saved');
      setMessage({ kind: 'success', text: 'File saved.' });
    } catch (cause) {
      if (targetKeyRef.current !== operationTarget) return;
      const failure = operationFailure(cause, "Artemis couldn't save this file. Try again.");
      if (failure.code === 'FILE_NOT_FOUND') setStatus('missing');
      setMessage({ kind: 'error', text: failure.message });
    } finally {
      if (targetKeyRef.current === operationTarget) setActivity(null);
    }
  }, [
    applyDocument,
    buffer,
    dirty,
    document,
    operations,
    projectId,
    readOnly,
    relativePath,
    targetKey,
  ]);

  const revert = useCallback(async () => {
    const operationTarget = targetKey;
    if (dirty) addHistory(buffer, 'Unsaved changes', null);
    setActivity('revert');
    setMessage(null);
    try {
      const next = await operations.revert({ projectId, relativePath });
      if (targetKeyRef.current !== operationTarget) return;
      applyDocument(next, 'Reloaded file');
      setMessage({
        kind: 'success',
        text: dirty
          ? 'Changes discarded. Your unsaved copy was kept in Past versions.'
          : 'Reloaded the saved version.',
      });
    } catch (cause) {
      if (targetKeyRef.current !== operationTarget) return;
      const failure = operationFailure(cause, "Artemis couldn't reload the saved file. Try again.");
      if (failure.code === 'FILE_NOT_FOUND') setStatus('missing');
      setMessage({ kind: 'error', text: failure.message });
    } finally {
      if (targetKeyRef.current === operationTarget) setActivity(null);
    }
  }, [addHistory, applyDocument, buffer, dirty, operations, projectId, relativePath, targetKey]);

  const reveal = useCallback(async () => {
    const operationTarget = targetKey;
    setActivity('reveal');
    setMessage(null);
    try {
      await operations.reveal({ projectId, relativePath });
      if (targetKeyRef.current !== operationTarget) return;
      setMessage({ kind: 'success', text: 'The file is shown in your file manager.' });
    } catch (cause) {
      if (targetKeyRef.current !== operationTarget) return;
      const failure = operationFailure(
        cause,
        "Artemis couldn't show this file in your file manager. Try again.",
      );
      if (failure.code === 'FILE_NOT_FOUND') setStatus('missing');
      setMessage({ kind: 'error', text: failure.message });
    } finally {
      if (targetKeyRef.current === operationTarget) setActivity(null);
    }
  }, [operations, projectId, relativePath, targetKey]);

  const openExternal = useCallback(async () => {
    const operationTarget = targetKey;
    setActivity('external');
    setMessage(null);
    try {
      await operations.openExternal({ projectId, relativePath });
      if (targetKeyRef.current !== operationTarget) return;
      setMessage({ kind: 'success', text: 'Opened the saved file in your default app.' });
    } catch (cause) {
      if (targetKeyRef.current !== operationTarget) return;
      const failure = operationFailure(
        cause,
        "Artemis couldn't open this file in another app. Try again.",
      );
      if (failure.code === 'FILE_NOT_FOUND') setStatus('missing');
      setMessage({ kind: 'error', text: failure.message });
    } finally {
      if (targetKeyRef.current === operationTarget) setActivity(null);
    }
  }, [operations, projectId, relativePath, targetKey]);

  const restoreHistory = useCallback(
    (entryId: string) => {
      if (readOnly || document?.readOnly === true) return;
      const entry = history.find((candidate) => candidate.id === entryId);
      if (entry === undefined) return;
      setBuffer(entry.content);
      setMessage({ kind: 'success', text: `Restored “${entry.label}” to the editor.` });
    },
    [document?.readOnly, history, readOnly],
  );

  return {
    status,
    activity,
    document,
    buffer,
    dirty,
    history,
    message,
    setBuffer: setEditableBuffer,
    retry,
    save,
    revert,
    reveal,
    openExternal,
    restoreHistory,
  };
}

function operationFailure(
  cause: unknown,
  fallback: string,
): { code: FileDomainErrorCode | null; message: string } {
  const candidate = cause as { code?: unknown; message?: unknown } | null;
  const parsedCode = FileDomainErrorCodeSchema.safeParse(candidate?.code);
  return {
    code: parsedCode.success ? parsedCode.data : null,
    message:
      parsedCode.success && typeof candidate?.message === 'string' && candidate.message.length > 0
        ? candidate.message.slice(0, 1_000)
        : fallback,
  };
}
