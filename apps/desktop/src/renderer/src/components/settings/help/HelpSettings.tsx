import { ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';
import { FirstRunTour } from '../../help/tour/FirstRunTour.js';
import { HELP_ARTICLES, searchHelpArticles } from './help-content.js';
import './HelpSettings.css';

export function HelpSettings({
  keyboardPreset,
  activeKeyboardPreset,
}: Pick<AppSettings, 'keyboardPreset'> & {
  activeKeyboardPreset: AppSettings['keyboardPreset'];
}) {
  const [query, setQuery] = useState('');
  const articles = useMemo(() => searchHelpArticles(query), [query]);
  const paletteShortcut = keyboardPreset === 'vscode' ? 'F1 or Ctrl/⌘ Shift P' : 'Ctrl/⌘ K';
  const paletteShortcutLabel =
    keyboardPreset === 'vscode'
      ? 'F1 or Control or Command plus Shift plus P'
      : 'Control or Command plus K';
  const presetLabel = keyboardPreset === 'vscode' ? 'VS Code preset' : 'Standard preset';
  const activePresetLabel =
    activeKeyboardPreset === 'vscode' ? 'VS Code preset' : 'Standard preset';

  return (
    <section className="help-settings" aria-labelledby="help-settings-title">
      <header>
        <span className="eyebrow">Local guide</span>
        <h3 id="help-settings-title">Help & shortcuts</h3>
        <p>
          Search step-by-step guides for setting up Forgeboard, running agents, reviewing their
          work, and recovering when something goes wrong. Everything here works offline and only
          uses the app — no file editing needed.
        </p>
      </header>

      <div className="help-shortcut" role="group" aria-labelledby="help-palette-shortcut-title">
        <span>
          <strong id="help-palette-shortcut-title">Command palette</strong>
          <small>
            {keyboardPreset === activeKeyboardPreset
              ? `${presetLabel} · currently active`
              : `${presetLabel} · not saved yet; ${activePresetLabel} is still active`}
          </small>
        </span>
        <kbd aria-label={paletteShortcutLabel}>{paletteShortcut}</kbd>
      </div>

      <details className="help-tour-replay">
        <summary>Replay Getting started tour</summary>
        <FirstRunTour keyboardPreset={activeKeyboardPreset} headingLevel={4} />
      </details>

      <label className="help-search">
        <span className="sr-only">Search local help</span>
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          name="help-search"
          value={query}
          placeholder="Search setup, agents, Git, recovery, privacy…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <p className="help-result-count" role="status" aria-live="polite">
        {articles.length === HELP_ARTICLES.length && query.trim() === ''
          ? `${articles.length} local guides`
          : `${articles.length} matching ${articles.length === 1 ? 'guide' : 'guides'}`}
      </p>

      <div className="help-articles">
        {articles.map((article, index) => {
          const Icon = article.icon;
          return (
            <details key={article.id} open={query.trim() !== '' || index === 0}>
              <summary>
                <span className="help-article-icon">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <span>
                  <strong>{article.title}</strong>
                  <small>{article.summary}</small>
                </span>
                <span className="help-article-toggle" aria-hidden="true">
                  <ChevronDown size={14} />
                </span>
              </summary>
              <ol>
                {article.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          );
        })}
        {articles.length === 0 && (
          <div className="help-empty">
            <Search size={18} aria-hidden="true" />
            <strong>No guides match your search</strong>
            <span>Try a word like agent, Git, Docker, preview, backup, or privacy.</span>
          </div>
        )}
      </div>
    </section>
  );
}
