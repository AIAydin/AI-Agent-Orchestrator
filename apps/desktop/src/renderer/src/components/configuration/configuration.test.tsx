// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandBuilder } from './CommandBuilder.js';
import {
  EnvironmentAllowlistEditor,
  environmentAllowlistIssues,
  parseEnvironmentNames,
} from './EnvironmentAllowlistEditor.js';
import { commandDependencyGuidance } from './dependency-guidance.js';

afterEach(cleanup);

describe('zero-code runtime configuration controls', () => {
  it('builds a literal argument vector and delegates executable authority to Browse', () => {
    const onChange = vi.fn();
    const onBrowse = vi.fn();
    render(
      <CommandBuilder
        label="Development server"
        name="development-server"
        value={{ executable: 'pnpm', arguments: [] }}
        purpose="preview"
        variant="compact"
        onChange={onChange}
        onBrowse={onBrowse}
      />,
    );

    fireEvent.change(
      screen.getByLabelText(
        'Development server arguments, one non-empty literal argument per line; empty lines ignored',
      ),
      { target: { value: 'run\ndev\n  --host  ' } },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Browse executable for Development server' }),
    );

    expect(onChange).toHaveBeenCalledWith({
      executable: 'pnpm',
      arguments: ['run', 'dev', '  --host  '],
    });
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/enable pnpm with Corepack/u)).toBeTruthy();
  });

  it('stores environment names only and reports invalid names before save', () => {
    const onChange = vi.fn();
    render(<EnvironmentHarness onChange={onChange} />);
    const input = screen.getByLabelText<HTMLInputElement>(
      'Environment variable names allowed into processes',
    );
    fireEvent.change(input, { target: { value: 'PATH,' } });
    expect(input.value).toBe('PATH,');
    fireEvent.change(input, {
      target: { value: 'PATH, CI, PATH' },
    });

    expect(onChange).toHaveBeenLastCalledWith(['PATH', 'CI']);
    fireEvent.blur(input);
    expect(input.value).toBe('PATH, CI');
    expect(screen.getByText(/secrets, and session values are not entered here/u)).toBeTruthy();
    expect(parseEnvironmentNames('PATH\nHOME, PATH')).toEqual(['PATH', 'HOME']);
    expect(environmentAllowlistIssues(['PATH', 'NOT-VALID'])).toEqual([
      expect.stringContaining('not a valid environment variable name'),
    ]);
  });

  it('gives actionable dependency guidance without guessing a shell command', () => {
    expect(commandDependencyGuidance('npm', 'check')).toMatch(/install Node\.js/u);
    expect(commandDependencyGuidance('/opt/tools/checker', 'check')).toMatch(/use Browse/u);
    expect(commandDependencyGuidance('', 'preview')).toMatch(/detected package script/u);
  });
});

function EnvironmentHarness({ onChange }: { readonly onChange: (value: string[]) => void }) {
  const [value, setValue] = useState(['PATH']);
  return (
    <EnvironmentAllowlistEditor
      name="environment"
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}
