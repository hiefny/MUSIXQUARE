type UiKitStage = 'app' | 'role' | 'start';

const TRACKS = [
  {
    title: 'Goldberg Aria',
    artist: 'J. S. Bach',
    dur: '4:51',
    source: 'file',
  },
  {
    title: 'Cello Suite No. 1 Prelude',
    artist: 'J. S. Bach',
    dur: '2:42',
    source: 'youtube',
  },
  {
    title: 'Well-Tempered Clavier Book I',
    artist: 'J. S. Bach',
    dur: '4:36',
    source: 'youtube-playlist',
  },
  { title: 'Gymnopédie No. 1', artist: 'Erik Satie', dur: '3:08', source: 'file' },
  { title: 'Clair de lune', artist: 'Claude Debussy', dur: '5:12', source: 'youtube' },
] as const satisfies readonly UiKitTrack[];

const DEVICES = [
  { name: 'iPhone 15 Pro (host)', role: 'CENTER', online: true },
  { name: 'MacBook Air', role: 'LEFT', online: true },
  { name: 'Pixel 8', role: 'RIGHT', online: true },
  { name: 'iPad mini', role: 'WOOFER', online: true },
] as const satisfies readonly UiKitDevice[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUiKitReactRuntime(value: unknown): value is UiKitReactRuntime {
  return (
    isRecord(value) &&
    typeof value.createElement === 'function' &&
    typeof value.useEffect === 'function' &&
    typeof value.useRef === 'function' &&
    typeof value.useState === 'function' &&
    typeof value.Fragment === 'symbol'
  );
}

function isUiKitReactDomRuntime(value: unknown): value is UiKitReactDomRuntime {
  return isRecord(value) && typeof value.createRoot === 'function';
}

const reactRuntime: unknown = window.React;
const reactDomRuntime: unknown = window.ReactDOM;
if (!isUiKitReactRuntime(reactRuntime) || !isUiKitReactDomRuntime(reactDomRuntime)) {
  throw new Error('MUSIXQUARE_UI_KIT_REACT_RUNTIME_REQUIRED');
}

const { useState, useEffect, useRef } = reactRuntime;

function App(): JSX.Element {
  const [stage, setStage] = useState<UiKitStage>('start');
  const [tab, setTab] = useState<UiKitTab>('home');
  const [role, setRole] = useState<UiKitRole>('center');
  const [playing, setPlaying] = useState(true);
  const [trackIdx, setTrackIdx] = useState(1);
  const [theme, setTheme] = useState<UiKitTheme>('dark');
  const [languageMode, setLanguageMode] = useState<UiKitLanguageMode>('system');
  const [uiSounds, setUiSounds] = useState(false);
  const [settingsSync, setSettingsSync] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const showToast = (message: string): void => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2_200);
  };

  const current = TRACKS[trackIdx] ?? TRACKS[0];
  const track: UiKitNowPlayingTrack = {
    title: current.title,
    artist: current.artist,
    cur: '1:24',
    dur: current.dur,
    progress: 34,
    source: current.source,
  };

  if (stage === 'start') {
    return (
      <div className="mq-app">
        <Toast message={toast} />
        <Start
          onHost={() => {
            setStage('role');
            showToast('Invite code: 492815');
          }}
          onGuest={() => {
            setStage('role');
            showToast('Joining...');
          }}
          onDemo={() => {
            setStage('app');
            showToast('Loading demo track...');
          }}
        />
      </div>
    );
  }

  if (stage === 'role') {
    return (
      <div className="mq-app">
        <Toast message={toast} />
        <div className="mq-body" style={{ padding: '40px 20px 40px' }}>
          <RoleSetup
            selected={role}
            onSelect={(nextRole) => {
              setRole(nextRole);
              showToast(`${nextRole.toUpperCase()} selected`);
            }}
            onDone={() => setStage('app')}
          />
        </div>
      </div>
    );
  }

  let body: UiKitReactNode = null;
  if (tab === 'home') {
    body = (
      <Home
        playing={playing}
        track={track}
        onTogglePlay={() => setPlaying((previous) => !previous)}
        onPrev={() => setTrackIdx((index) => Math.max(0, index - 1))}
        onNext={() => setTrackIdx((index) => Math.min(TRACKS.length - 1, index + 1))}
      />
    );
  } else if (tab === 'playlist') {
    body = (
      <Playlist
        tracks={TRACKS}
        activeIdx={trackIdx}
        playing={playing}
        onPick={(index) => {
          const selectedTrack = TRACKS[index];
          if (!selectedTrack) return;
          setTrackIdx(index);
          setPlaying(true);
          showToast(`Playing: ${selectedTrack.title}`);
        }}
        onAdd={() => showToast('No media yet')}
        onRemove={(index) => {
          const selectedTrack = TRACKS[index];
          if (selectedTrack) showToast(`Remove: ${selectedTrack.title}`);
        }}
      />
    );
  } else if (tab === 'connect') {
    body = (
      <Connect code="492815" devices={DEVICES} onCopy={() => showToast('Invite link copied')} />
    );
  } else if (tab === 'settings') {
    body = (
      <Settings
        languageMode={languageMode}
        onLanguageMode={setLanguageMode}
        onLeave={() => setStage('start')}
        onSettingsSync={setSettingsSync}
        theme={theme}
        onTheme={setTheme}
        onUiSounds={setUiSounds}
        settingsSync={settingsSync}
        uiSounds={uiSounds}
      />
    );
  } else {
    body = (
      <>
        <div className="mq-title">Help</div>
        <div className="mq-setting-section">
          <div className="mq-setting-header">
            <h3>Using MUSIXQUARE</h3>
          </div>
          <div className="mq-setting-description">
            The production Help tab contains localized guides, policies, and project links. This
            sample keeps only the tab and its navigation contract.
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="mq-app">
      <Toast message={toast} />
      <AppShell
        tab={tab}
        onTab={setTab}
        onAccount={() => showToast('Account dialog is not included in this sample')}
      >
        {body}
      </AppShell>
    </div>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('MUSIXQUARE_UI_KIT_ROOT_REQUIRED');
reactDomRuntime.createRoot(rootElement).render(<App />);
