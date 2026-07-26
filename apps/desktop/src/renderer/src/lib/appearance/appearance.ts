import type { AppSettings } from '../../../../shared/application/contracts.js';

export type AppearanceSettings = Pick<AppSettings, 'theme' | 'density' | 'reducedMotion'>;

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Applies theme, density, and reduced motion to the document so CSS tokens follow them. */
export function applyAppearance(settings: AppearanceSettings): void {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemPrefersDark());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.density = settings.density;
  document.documentElement.dataset.reducedMotion = String(settings.reducedMotion);
}

/** Re-applies appearance when the operating system switches between light and dark. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof media.addEventListener !== 'function') return () => undefined;
  const listener = () => onChange();
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
