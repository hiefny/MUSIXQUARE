function Settings({ theme, onTheme, reverb, onReverb, volume, onVolume }) {
  return (
    <>
      <div className="mq-title">Settings</div>

      <div className="mq-card">
        <div className="mq-card-hdr"><h3>Theme</h3></div>
        <div className="mq-seg">
          <button className={theme === 'dark' ? 'active' : ''} onClick={() => onTheme('dark')}>Dark</button>
          <button className={theme === 'light' ? 'active' : ''} onClick={() => onTheme('light')}>Light</button>
        </div>
      </div>

      <div className="mq-card">
        <div className="mq-card-hdr">
          <h3>Volume</h3>
          <span className="mq-badge" style={{ background: 'transparent', color: 'var(--text-sub)' }}>{volume}%</span>
        </div>
        <input className="mq-slider" type="range" min="0" max="100" value={volume}
               style={{ '--range-progress': `${volume}%` }}
               onChange={e => onVolume(Number(e.target.value))} />
      </div>

      <div className="mq-card">
        <div className="mq-card-hdr">
          <h3>Reverb</h3>
          <span className="mq-badge">HOST-CTRL</span>
        </div>
        <div className="mq-seg" style={{ marginBottom: 14 }}>
          {['Off','Studio','Arena','Advanced'].map(name => (
            <button key={name} className={reverb === name ? 'active' : ''} onClick={() => onReverb(name)}>
              {name}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-sub)', fontWeight: 600, marginBottom: 6 }}>
          <span>Decay time</span><span>2.4s</span>
        </div>
        <input className="mq-slider" type="range" defaultValue="40" style={{ '--range-progress': '40%' }} />
      </div>

      <div className="mq-card">
        <div className="mq-card-hdr">
          <h3>Equalizer</h3>
          <span className="mq-badge">SELF-CTRL</span>
        </div>
        <div className="mq-seg">
          {['Off','Bright','Warm','Advanced'].map(name => (
            <button key={name} className={name === 'Warm' ? 'active' : ''}>{name}</button>
          ))}
        </div>
      </div>
    </>
  );
}
window.Settings = Settings;
