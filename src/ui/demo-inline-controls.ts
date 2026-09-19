import { getState } from '../core/state.ts';
import { t } from '../i18n/index.ts';

interface DemoInlineControlsOptions {
  signal: AbortSignal;
  onOpen(): void;
  onClose(): void;
  onSync(): void;
}

/** The disclosure owns presentation only; playback and offsets keep their existing owners. */
export function bindDemoInlineControls({
  signal,
  onOpen,
  onClose,
  onSync,
}: DemoInlineControlsOptions): () => void {
  const opener = document.getElementById('btn-demo-settings');
  const header = opener?.closest<HTMLElement>('.demo-track-header');
  const controls = document.getElementById('demo-inline-controls');
  if (!opener || !header || !controls) return () => {};
  const copy = header.querySelector<HTMLElement>('.demo-track-copy');
  let expanded = false;
  const syncIsOpen = () =>
    document.getElementById('manual-sync-overlay')?.classList.contains('show');

  const setExpanded = (next: boolean, restoreFocus = false) => {
    const changed = expanded !== next;
    expanded = next;
    // Move focus before making its subtree inert, including keyboard dismissal.
    if (!next && (restoreFocus || controls.contains(document.activeElement))) {
      if (getState('demo.active')) opener.focus();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    header.classList.toggle('demo-controls-expanded', next);
    opener.setAttribute('aria-expanded', String(next));
    const label = next ? 'common.close' : 'nav.settings';
    opener.setAttribute('data-i18n-aria-label', label);
    opener.setAttribute('aria-label', t(label));
    controls.toggleAttribute('inert', !next);
    controls.setAttribute('aria-hidden', String(!next));
    copy?.setAttribute('aria-hidden', String(next));
    if (changed) {
      if (next) onOpen();
      else onClose();
    }
  };
  setExpanded(false);
  opener.addEventListener(
    'click',
    () => {
      if (getState('demo.active')) setExpanded(!expanded);
    },
    { signal },
  );
  document.getElementById('btn-demo-sync')?.addEventListener(
    'click',
    () => {
      if (expanded && getState('demo.active')) onSync();
    },
    { signal },
  );
  header.addEventListener(
    'keydown',
    (event) => {
      if (
        !expanded ||
        syncIsOpen() ||
        event.key !== 'Escape' ||
        event.isComposing ||
        event.keyCode === 229
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false, true);
    },
    { signal },
  );
  const dismissOutside = (event: Event) => {
    if (!expanded || syncIsOpen() || !(event.target instanceof Node)) return;
    if (!header.contains(event.target)) setExpanded(false);
  };
  document.addEventListener('pointerdown', dismissOutside, { signal });
  return () => setExpanded(false);
}
