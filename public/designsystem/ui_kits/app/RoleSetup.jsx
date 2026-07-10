// Prototype-only role picker. Production currently assigns Center during setup
// and exposes role changes after joining.
function RoleSetup({ selected, onSelect, onDone }) {
  const roles = [
    { id: 'center', name: 'Center',    hint: 'Stereo output',    icon: I.center },
    { id: 'left',   name: 'Left',      hint: 'L channel only',   icon: I.left   },
    { id: 'right',  name: 'Right',     hint: 'R channel only',   icon: I.right  },
    { id: 'sub',    name: 'Subwoofer', hint: 'Low-frequency mix', icon: I.sub    },
  ];
  const activeRole = roles.find(r => r.id === selected);
  return (
    <>
      <div className="mq-title">Set this device's role</div>
      <div className="mq-role-hero">
        {activeRole ? <activeRole.icon/> : <I.sub/>}
      </div>
      <div className="mq-roles" style={{ marginTop: 16 }}>
        {roles.map(r => (
          <button key={r.id}
                  className={'mq-role' + (r.id === selected ? ' active' : '')}
                  onClick={() => onSelect(r.id)}>
            <r.icon/>
            <div>
              <div className="label">{r.name}</div>
              <div className="hint">{r.hint}</div>
            </div>
          </button>
        ))}
      </div>
      <button className="mq-cta" style={{ marginTop: 16 }} onClick={onDone}>
        Done
      </button>
    </>
  );
}
window.RoleSetup = RoleSetup;
