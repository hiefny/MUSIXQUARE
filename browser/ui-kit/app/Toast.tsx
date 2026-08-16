interface ToastProps {
  readonly message: string | null;
}

// Pill toast prototype.
function Toast({ message }: ToastProps): JSX.Element | null {
  if (!message) return null;
  return (
    <div className="mq-toast-wrap" key={message}>
      <div className="mq-toast">{message}</div>
    </div>
  );
}

window.Toast = Toast;
