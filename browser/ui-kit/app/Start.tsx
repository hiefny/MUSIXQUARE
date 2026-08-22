interface StartProps {
  readonly onDemo: () => void;
  readonly onGuest: () => void;
  readonly onHost: () => void;
}

// Start / pre-session screen.
// Prototype copy modeled on the English setup strings; src/i18n is authoritative.
function Start({ onHost, onGuest, onDemo }: StartProps): JSX.Element {
  return (
    <div className="mq-start">
      <div className="hero-logo">
        <Wordmark />
      </div>
      <div className="tagline">
        Listen together, anywhere
        <br />
        The perfect sound experience
      </div>
      <div className="actions">
        <button className="mq-cta" onClick={onHost}>
          I'll host
        </button>
        <button className="mq-cta ghost" onClick={onGuest}>
          Join a session
        </button>
        <button className="demo" onClick={onDemo}>
          Take a Tour
        </button>
      </div>
    </div>
  );
}

window.Start = Start;
