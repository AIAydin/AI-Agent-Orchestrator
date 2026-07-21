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
    summary: 'Open a folder, create a new one, or explore the demo.',
    icon: FolderGit2,
    steps: () => [
      '“Open local”, “Create empty”, and the demo stay entirely on this device.',
      'Only “Clone” uses the internet — and only with the Git address you type in.',
      'Recent projects are just shortcuts. Moved a folder? Point Forgeboard to its new place.',
    ],
  },
  {
    id: 'workspace',
    title: 'Find your workspace',
    summary: 'How the main panels fit together.',
    icon: LayoutDashboard,
    steps: (paletteShortcut) => [
      'Add items from the left rail, connect them on the canvas, and edit the selected one in the inspector on the right.',
      'The activity drawer shows what your runs and checks did.',
      `Press ${paletteShortcut} for the command palette — arrow keys and Enter run an action.`,
    ],
  },
  {
    id: 'review',
    title: 'Review before anything runs',
    summary: 'Inspect every launch and Git change before it happens.',
    icon: BellRing,
    steps: () => [
      '“Review & run” shows the exact program, arguments, context, provider, and permissions before you approve.',
      'Notifications never leave this device.',
      'Open “Changes” to review files before you stage, discard, or commit.',
    ],
  },
  {
    id: 'help',
    title: 'Get help and control your data',
    summary: 'Built-in guides, privacy controls, and recovery tools — all inside the app.',
    icon: BookOpenText,
    steps: () => [
      'Settings → Help & shortcuts searches the built-in guides: setup, keyboard, Git, Docker, recovery, troubleshooting.',
      'Settings → Data & privacy shows what’s stored and what providers can receive — back up, export, or delete it there.',
      'Something unavailable? Search Help — everyday fixes stay in the app.',
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
          Four quick stops. The tour is built in — it contacts nothing and changes none of your
          projects or settings.
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
