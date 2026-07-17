interface LocationReplacer {
  replace(url: string): void;
}

/** Leave the current route without keeping an auto-join room URL in history. */
export function navigateToAppHome(location: LocationReplacer = window.location): void {
  location.replace('/');
}
