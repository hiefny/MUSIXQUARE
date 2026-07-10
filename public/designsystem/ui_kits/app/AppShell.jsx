function AppShell({ tab, onTab, onLeave, children }) {
  const tabs = [
    { id: 'home',     label: 'Home',     icon: I.home     },
    { id: 'playlist', label: 'Playlist', icon: I.list     },
    { id: 'connect',  label: 'Connect',  icon: I.users    },
    { id: 'settings', label: 'Settings', icon: I.settings },
  ];
  return (
    <>
      <header className="mq-header">
        <div className="brand"><Wordmark/></div>
        <div className="right">
          <button className="mq-iconbtn" aria-label="help"><I.help/></button>
          <button className="mq-iconbtn" aria-label="leave" onClick={onLeave}><I.close/></button>
        </div>
      </header>
      <div className="mq-body">{children}</div>
      <nav className="mq-nav">
        {tabs.map(t => (
          <button key={t.id}
                  className={'tab' + (tab === t.id ? ' active' : '')}
                  onClick={() => onTab(t.id)}>
            <t.icon/><span>{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
window.AppShell = AppShell;
