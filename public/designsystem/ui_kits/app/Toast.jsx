// Glass pill toast
function Toast({ message }) {
  if (!message) return null;
  return (
    <div className="mq-toast-wrap" key={message}>
      <div className="mq-toast">{message}</div>
    </div>
  );
}
window.Toast = Toast;
