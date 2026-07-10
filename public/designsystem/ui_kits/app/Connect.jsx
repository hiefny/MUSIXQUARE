function Connect({ code, devices, onCopy }) {
  return (
    <>
      <div className="mq-title">Connect</div>

      <div className="mq-card">
        <div className="mq-invite">
          <span className="lbl">Invite code</span>
          <span className="code">{code}</span>
          <button className="mq-cta" style={{ width: 'auto', padding: '0 22px', height: 40, marginTop: 6 }}
                  onClick={onCopy}>
            <I.copy style={{ width: 18, height: 18, fill: '#fff' }}/> Copy invite link
          </button>
        </div>
      </div>

      <div className="mq-card">
        <div className="mq-card-hdr">
          <h3>{devices.length} Connected Devices</h3>
          <span className="mq-badge">HOST</span>
        </div>
        {devices.map((d, i) => (
          <div className="mq-device" key={i}>
            <span className="dot" style={{ opacity: d.online ? 1 : 0.3 }}/>
            <span className="nm">{d.name}</span>
            <span className="role">{d.role}</span>
          </div>
        ))}
      </div>
    </>
  );
}
window.Connect = Connect;
