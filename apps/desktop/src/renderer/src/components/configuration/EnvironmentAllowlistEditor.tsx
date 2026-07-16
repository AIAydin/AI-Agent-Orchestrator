import { useEffect, useRef, useState } from 'react';

import './configuration.css';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MAX_ENVIRONMENT_NAMES = 256;

interface EnvironmentAllowlistEditorProps {
  readonly name: string;
  readonly value: readonly string[];
  readonly onChange: (value: string[]) => void;
  readonly compact?: boolean;
}

export function EnvironmentAllowlistEditor({
  name,
  value,
  onChange,
  compact = false,
}: EnvironmentAllowlistEditorProps) {
  const serializedValue = value.join(', ');
  const [inputValue, setInputValue] = useState(serializedValue);
  const expectedSerializedValue = useRef(serializedValue);
  const issues = environmentAllowlistIssues(value);
  const helpId = `${name}-help`;
  const issueId = `${name}-issue`;

  useEffect(() => {
    if (serializedValue === expectedSerializedValue.current) return;
    expectedSerializedValue.current = serializedValue;
    setInputValue(serializedValue);
  }, [serializedValue]);

  return (
    <label className={compact ? 'environment-editor compact' : 'environment-editor'}>
      Environment variable names allowed into processes
      <input
        name={name}
        value={inputValue}
        autoComplete="off"
        spellCheck={false}
        aria-label="Environment variable names allowed into processes"
        aria-invalid={issues.length > 0}
        aria-describedby={`${helpId}${issues.length > 0 ? ` ${issueId}` : ''}`}
        placeholder="PATH, HOME, LANG"
        onChange={(event) => {
          const nextInput = event.target.value;
          const names = parseEnvironmentNames(nextInput);
          expectedSerializedValue.current = names.join(', ');
          setInputValue(nextInput);
          onChange(names);
        }}
        onBlur={() => setInputValue(serializedValue)}
      />
      <small id={helpId}>
        Names only are saved. Values are resolved from the current app environment at launch and are
        never persisted. Provider tokens, secrets, and session values are not entered here.
      </small>
      {issues[0] !== undefined && (
        <small id={issueId} className="environment-editor-issue" role="alert">
          {issues[0]}
        </small>
      )}
    </label>
  );
}

export function parseEnvironmentNames(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

export function environmentAllowlistIssues(names: readonly string[]): string[] {
  const issues: string[] = [];
  if (names.length > MAX_ENVIRONMENT_NAMES) {
    issues.push(`Use at most ${String(MAX_ENVIRONMENT_NAMES)} environment variable names.`);
  }
  const invalid = names.find((name) => !ENVIRONMENT_NAME.test(name) || name.length > 512);
  if (invalid !== undefined) {
    issues.push(
      'One entry is not a valid environment variable name. Use letters, numbers, and underscores, starting with a letter or underscore.',
    );
  }
  if (new Set(names).size !== names.length) {
    issues.push('Environment variable names must be unique.');
  }
  return issues;
}
