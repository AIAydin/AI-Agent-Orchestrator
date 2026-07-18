import { BellRing, BookOpenText, FolderGit2, LayoutDashboard, type LucideIcon } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';

import type { AppSettings } from '../../../../../shared/application/contracts.js';

import './FirstRunTour.css';

interface TourStop {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly icon: LucideIcon;
  readonly steps: (paletteShortcut: string) => readonly string[];
}

const TOUR_STOPS: readonly TourStop[] = [
  {
    id: 'project',
    title: 'Start with a project',
    summary: 'Open a folder from this computer, create a new one, or explore the built-in demo.',
    icon: FolderGit2,
    steps: () => [
      '“Open local” opens a folder you choose. “Create empty” and the demo stay entirely on this device.',
      '“Clone” is the only option here that uses the internet, and only with the Git address you type in.',
      'Recent projects are just shortcuts on this device. If you move a folder, you can point Forgeboard to its new place.',
    ],
  },
  {
    id: 'workspace',
    title: 'Find your workspace',
    summary: 'Use the rail, canvas, inspector, activity drawer, and command palette together.',
    icon: LayoutDashboard,
    steps: (paletteShortcut) => [
      'Add items from the left rail, connect them on the canvas, and change settings for the selected item in the right panel (the inspector).',
      'The activity drawer shows what your runs and checks did while you work.',
      `Press ${paletteShortcut} to open the command palette, then use the arrow keys and Enter to run an action.`,
    ],
  },
  {
    id: 'review',
    title: 'Review before anything runs',
    summary: 'Forgeboard lets you inspect every launch, Git change, and bit of activity.',
    icon: BellRing,
    steps: () => [
      '“Review & run” shows the exact program, arguments, context, provider, and permissions before you approve anything.',
      'Notifications stay on this device — nothing is sent anywhere.',
      'Open “Changes” to review your files before you stage, discard, or commit anything.',
    ],
  },
  {
    id: 'help',
    title: 'Get help and control your data',
    summary: 'Search the built-in guides and find privacy, recovery, and troubleshooting controls.',
    icon: BookOpenText,
    steps: () => [
      'Open Settings → Help & shortcuts to search the built-in guides for setup, keyboard, Git, Docker, recovery, and troubleshooting.',
      'Open Settings → Data & privacy to see what is stored, manage backups, review what providers can receive, and export or delete your data.',
      'If something is not available — a run, a preview, a command-line tool, a Docker image, or a project — search Help for the fix. Everyday fixes stay in the app.',
    ],
  },
] as const;

export function FirstRunTour({
  keyboardPreset,
  headingLevel,
}: {
  readonly keyboardPreset: AppSettings['keyboardPreset'];
  readonly headingLevel: 2 | 4;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const instanceId = useId();
  const activeStop = TOUR_STOPS[activeIndex] ?? TOUR_STOPS[0]!;
  const paletteShortcut = keyboardPreset === 'vscode' ? 'F1 or Ctrl/⌘ Shift P' : 'Ctrl/⌘ K';
  const Heading = headingLevel === 2 ? 'h2' : 'h4';
  const PanelHeading = headingLevel === 2 ? 'h3' : 'h5';
  const titleId = `${instanceId}-tour-title`;
  const panelId = `${instanceId}-tour-panel-${activeStop.id}`;
  const tabId = `${instanceId}-tour-tab-${activeStop.id}`;
  const Icon = activeStop.icon;

  function selectStep(index: number, focus: boolean): void {
    const boundedIndex = Math.min(Math.max(index, 0), TOUR_STOPS.length - 1);
    setActiveIndex(boundedIndex);
    if (focus) tabs.current[boundedIndex]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % TOUR_STOPS.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + TOUR_STOPS.length) % TOUR_STOPS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = TOUR_STOPS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectStep(nextIndex, true);
  }

  return (
    <section className="first-run-tour" aria-labelledby={titleId}>
      <header>
        <span>Optional guide</span>
        <Heading id={titleId}>Getting started tour</Heading>
        <p>
          Four quick stops show you around. The tour is built in — it contacts nothing and changes
          none of your projects or settings.
        </p>
      </header>

      <div className="first-run-tour-tabs" role="tablist" aria-label="Getting started tour steps">
        {TOUR_STOPS.map((stop, index) => (
          <button
            key={stop.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            id={`${instanceId}-tour-tab-${stop.id}`}
            type="button"
            role="tab"
            aria-selected={index === activeIndex}
            aria-current={index === activeIndex ? 'step' : undefined}
            aria-controls={`${instanceId}-tour-panel-${stop.id}`}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => selectStep(index, false)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            <span>{index + 1}</span>
            <small>{stop.title}</small>
          </button>
        ))}
      </div>

      <article
        key={activeStop.id}
        id={panelId}
        className="first-run-tour-panel"
        role="tabpanel"
        aria-labelledby={tabId}
        aria-live="polite"
      >
        <span className="first-run-tour-icon">
          <Icon size={20} aria-hidden="true" />
        </span>
        <div>
          <small>
            Step {activeIndex + 1} of {TOUR_STOPS.length}
          </small>
          <PanelHeading>{activeStop.title}</PanelHeading>
          <p>{activeStop.summary}</p>
          <ol>
            {activeStop.steps(paletteShortcut).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </article>

      <footer>
        <button
          type="button"
          className="button ghost"
          disabled={activeIndex === 0}
          onClick={() => selectStep(activeIndex - 1, false)}
        >
          Previous stop
        </button>
        {activeIndex === TOUR_STOPS.length - 1 ? (
          <button type="button" className="button" onClick={() => selectStep(0, false)}>
            Restart tour
          </button>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() => selectStep(activeIndex + 1, false)}
          >
            Next: {TOUR_STOPS[activeIndex + 1]?.title}
          </button>
        )}
      </footer>
    </section>
  );
}
