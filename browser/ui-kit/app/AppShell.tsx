interface AppShellProps {
  readonly children: UiKitReactNode;
  readonly onAccount: () => void;
  readonly onTab: (tab: UiKitTab) => void;
  readonly tab: UiKitTab;
}

function AppShell({ tab, onTab, onAccount, children }: AppShellProps): JSX.Element {
  const tabs: readonly {
    readonly icon: UiKitIcon;
    readonly id: UiKitTab;
    readonly label: string;
  }[] = [
    { id: 'home', label: 'Home', icon: I.home },
    { id: 'playlist', label: 'Playlist', icon: I.list },
    { id: 'connect', label: 'Connect', icon: I.connect },
    { id: 'settings', label: 'Settings', icon: I.settings },
    { id: 'guide', label: 'Help', icon: I.help },
  ];
  return (
    <>
      <header className="mq-header">
        <div className="brand">
          <Wordmark />
        </div>
        <div className="right">
          <button className="mq-role-badge" aria-label="Open account" onClick={onAccount}>
            <i />
            <span>HOST</span>
          </button>
        </div>
      </header>
      <div className="mq-body">{children}</div>
      <nav className="mq-nav" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={'tab' + (tab === item.id ? ' active' : '')}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => onTab(item.id)}
          >
            <item.icon />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

window.AppShell = AppShell;
