interface SettingsProps {
  readonly languageMode: UiKitLanguageMode;
  readonly onLanguageMode: (mode: UiKitLanguageMode) => void;
  readonly onLeave: () => void;
  readonly onSettingsSync: (enabled: boolean) => void;
  readonly onTheme: (theme: UiKitTheme) => void;
  readonly onUiSounds: (enabled: boolean) => void;
  readonly settingsSync: boolean;
  readonly theme: UiKitTheme;
  readonly uiSounds: boolean;
}

function Settings({
  languageMode,
  onLanguageMode,
  onLeave,
  onSettingsSync,
  onTheme,
  onUiSounds,
  settingsSync,
  theme,
  uiSounds,
}: SettingsProps): JSX.Element {
  return (
    <>
      <div className="mq-title">Settings</div>

      <div className="mq-setting-section">
        <div className="mq-setting-header">
          <h3>Language</h3>
        </div>
        <div className="mq-setting-description">
          Choose a language or follow your system language.
        </div>
        <div className="mq-settings-grid">
          <button
            className={'mq-setting-option' + (languageMode === 'select' ? ' active' : '')}
            aria-pressed={languageMode === 'select'}
            onClick={() => onLanguageMode('select')}
          >
            <I.globe />
            <span>Select</span>
          </button>
          <button
            className={'mq-setting-option' + (languageMode === 'system' ? ' active' : '')}
            aria-pressed={languageMode === 'system'}
            onClick={() => onLanguageMode('system')}
          >
            <I.device />
            <span>System</span>
          </button>
        </div>
      </div>

      <div className="mq-setting-section">
        <div className="mq-setting-header">
          <h3>Theme</h3>
        </div>
        <div className="mq-setting-description">Choose a light or dark appearance.</div>
        <div className="mq-settings-grid">
          <button
            className={'mq-setting-option' + (theme === 'light' ? ' active' : '')}
            aria-pressed={theme === 'light'}
            onClick={() => onTheme('light')}
          >
            <I.sun />
            <span>Light</span>
          </button>
          <button
            className={'mq-setting-option' + (theme === 'dark' ? ' active' : '')}
            aria-pressed={theme === 'dark'}
            onClick={() => onTheme('dark')}
          >
            <I.moon />
            <span>Dark</span>
          </button>
        </div>
      </div>

      <div className="mq-setting-section">
        <div className="mq-setting-header">
          <h3>UI Sounds</h3>
        </div>
        <div className="mq-setting-description">
          Turn announcement, entry/exit, and touch sounds on or off.
        </div>
        <div className="mq-settings-grid">
          <button
            className={'mq-setting-option' + (uiSounds ? ' active' : '')}
            aria-pressed={uiSounds}
            onClick={() => onUiSounds(true)}
          >
            <I.uiSound />
            <span>On</span>
          </button>
          <button
            className={'mq-setting-option' + (!uiSounds ? ' active' : '')}
            aria-pressed={!uiSounds}
            onClick={() => onUiSounds(false)}
          >
            <I.block />
            <span>Off</span>
          </button>
        </div>
      </div>

      <div className="mq-setting-section">
        <div className="mq-setting-header">
          <h3>Settings Sync</h3>
        </div>
        <div className="mq-setting-description">
          Keep supported audio settings synchronized across the room.
        </div>
        <div className="mq-settings-grid">
          <button
            className={'mq-setting-option' + (settingsSync ? ' active' : '')}
            aria-pressed={settingsSync}
            onClick={() => onSettingsSync(true)}
          >
            <I.settingsSync />
            <span>On</span>
          </button>
          <button
            className={'mq-setting-option' + (!settingsSync ? ' active' : '')}
            aria-pressed={!settingsSync}
            onClick={() => onSettingsSync(false)}
          >
            <I.block />
            <span>Off</span>
          </button>
        </div>
      </div>

      <div className="mq-leave-section">
        <div className="mq-setting-header">
          <h3>Session</h3>
        </div>
        <div className="mq-setting-description">Disconnect this device and return to start.</div>
        <button className="mq-leave-session" aria-label="leave" onClick={onLeave}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
          </svg>
          <span>Leave session</span>
        </button>
      </div>
    </>
  );
}

window.Settings = Settings;
