// Start / pre-session screen.
// Copy taken from src/i18n/en.ts: setup.host_button, setup.guest_button, etc.
function Start({ onHost, onGuest, onDemo }) {
  return (
    <div className="mq-start">
      <div className="hero-logo"><Wordmark /></div>
      <div className="tagline">
        Listen together, anywhere<br/>
        The perfect sound experience
      </div>
      <div className="actions">
        <button className="mq-cta" onClick={onHost}>I'll host</button>
        <button className="mq-cta ghost" onClick={onGuest}>Join a session</button>
        <button className="demo" onClick={onDemo}>Try it (Demo)</button>
      </div>
    </div>
  );
}
window.Start = Start;
