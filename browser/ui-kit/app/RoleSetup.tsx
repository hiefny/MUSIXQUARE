interface RoleSetupProps {
  readonly onDone: () => void;
  readonly onSelect: (role: UiKitRole) => void;
  readonly selected: UiKitRole;
}

interface UiKitRoleOption {
  readonly hint: string;
  readonly icon: UiKitIcon;
  readonly id: UiKitRole;
  readonly name: string;
}

// Prototype-only role picker. Production currently assigns Center during setup
// and exposes role changes after joining.
function RoleSetup({ selected, onSelect, onDone }: RoleSetupProps): JSX.Element {
  const roles: readonly UiKitRoleOption[] = [
    { id: 'center', name: 'Center', hint: 'Stereo output', icon: I.center },
    { id: 'left', name: 'Left', hint: 'L channel only', icon: I.left },
    { id: 'right', name: 'Right', hint: 'R channel only', icon: I.right },
    { id: 'sub', name: 'Subwoofer', hint: 'Low-frequency mix', icon: I.sub },
  ];
  const activeRole = roles.find((role) => role.id === selected);
  return (
    <>
      <div className="mq-title">Set this device's role</div>
      <div className="mq-role-hero">{activeRole ? <activeRole.icon /> : <I.sub />}</div>
      <div className="mq-roles" style={{ marginTop: 16 }}>
        {roles.map((role) => (
          <button
            key={role.id}
            className={'mq-role' + (role.id === selected ? ' active' : '')}
            onClick={() => onSelect(role.id)}
          >
            <role.icon />
            <div>
              <div className="label">{role.name}</div>
              <div className="hint">{role.hint}</div>
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
