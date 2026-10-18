// Leaving the dashboard for a provider's sign-in. A module of its own, so a component test
// can stand in for the browser's address bar, which jsdom cannot change.
export function leaveFor(url: string): void {
  window.location.assign(url);
}
