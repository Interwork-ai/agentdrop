import { useEffect } from 'react';
import { useNavigate } from 'react-router';

/**
 * Opens what a clicked browser notification points to. The service worker (public/sw.js `openAppPath`) posts
 * `{ type: 'agentdrop:open', path }` to an open tab and waits for this page to confirm; routing here instead of a
 * worker-side `navigate()` also works in a tab the worker does not control, and keeps the app loaded. Only paths
 * inside the dashboard are followed, whatever the message says.
 */
export function NotificationNavigation() {
  const nav = useNavigate();
  useEffect(() => {
    const container = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type !== 'agentdrop:open' || typeof data.path !== 'string') return;
      let target: URL;
      try {
        target = new URL(data.path, window.location.origin);
      } catch {
        return;
      }
      if (target.origin !== window.location.origin || !target.pathname.startsWith('/app/')) return;
      nav(`${target.pathname}${target.search}${target.hash}`);
      event.ports[0]?.postMessage('opened');
    };
    container.addEventListener('message', onMessage);
    // addEventListener (unlike onmessage) does not start delivery by itself
    container.startMessages();
    return () => container.removeEventListener('message', onMessage);
  }, [nav]);
  return null;
}
