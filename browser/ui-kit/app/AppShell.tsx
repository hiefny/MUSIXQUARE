interface AppShellProps {
  readonly children: UiKitReactNode;
  readonly onLeave: () => void;
  readonly onTab: (tab: UiKitTab) => void;
  readonly tab: UiKitTab;
}

function AppShell({ tab, onTab, onLeave, children }: AppShellProps): JSX.Element {
  const tabs: readonly {
    readonly icon: UiKitIcon;
    readonly id: UiKitTab;
    readonly label: string;
  }[] = [
    { id: 'home', label: 'Home', icon: I.home },
    { id: 'playlist', label: 'Playlist', icon: I.list },
    { id: 'connect', label: 'Connect', icon: I.users },
    { id: 'settings', label: 'Settings', icon: I.settings },
  ];
  return (
    <>
      <header className="mq-header">
        <div className="brand">
          <Wordmark />
        </div>
        <div className="right">
          <button className="mq-iconbtn" aria-label="help">
            <I.help />
          </button>
          <button className="mq-iconbtn" aria-label="leave" onClick={onLeave}>
            <I.close />
          </button>
        </div>
      </header>
      <div className="mq-body">{children}</div>
      <nav className="mq-nav">
        {tabs.map((item) => (
          <button
            key={item.id}
            className={'tab' + (tab === item.id ? ' active' : '')}
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
