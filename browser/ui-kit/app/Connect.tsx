interface ConnectProps {
  readonly code: string;
  readonly devices: readonly UiKitDevice[];
  readonly onCopy: () => void;
}

function Connect({ code, devices, onCopy }: ConnectProps): JSX.Element {
  return (
    <>
      <div className="mq-title">Connect</div>

      <div className="mq-card">
        <div className="mq-invite">
          <span className="lbl">Invite code</span>
          <span className="code">{code}</span>
          <button
            className="mq-cta"
            style={{ width: 'auto', padding: '0 22px', height: 40, marginTop: 6 }}
            onClick={onCopy}
          >
            <I.copy style={{ width: 18, height: 18, fill: '#fff' }} /> Copy invite link
          </button>
        </div>
      </div>

      <div className="mq-card">
        <div className="mq-card-hdr">
          <h3>{devices.length} Connected Devices</h3>
          <span className="mq-badge">HOST</span>
        </div>
        {devices.map((device, index) => (
          <div className="mq-device" key={index}>
            <span className="dot" style={{ opacity: device.online ? 1 : 0.3 }} />
            <span className="nm">{device.name}</span>
            <span className="role">{device.role}</span>
          </div>
        ))}
      </div>
    </>
  );
}

window.Connect = Connect;
