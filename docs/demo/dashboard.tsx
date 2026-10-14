import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SessionProvider } from '../../apps/web/src/lib/session.js';
import { MailboxPage } from '../../apps/web/src/pages/mailbox.js';
import { DEMO_DROP_ID, DEMO_H_ID, demoDrop, demoInbox, demoMe } from './fixtures.js';

/**
 * Local illustrative transport. Only these fixture requests are accepted, and no request falls through to
 * the network. The real dashboard's ordinary mark-read action changes this in-memory fixture only.
 */
function fixtureTransport(): typeof fetch {
  // The preceding scene showed Alice the requested body in her agent. Person-wide read state carries over.
  let read = true;
  let version = 1;
  const base = `/v1/me/endpoints/${DEMO_H_ID}/drops`;
  return async (input, init) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.origin !== window.location.origin) {
      throw new Error('The illustrative demo cannot request another origin.');
    }
    if (method === 'GET') {
      if (url.pathname === '/v1/me') return Response.json(demoMe);
      if (url.pathname === '/v1/me/push') {
        return Response.json({ available: false, vapid_public_key: null, subscriptions: [] });
      }
      if (url.pathname === base) return Response.json(demoInbox(read, version));
      if (url.pathname === `${base}/${DEMO_DROP_ID}`) {
        return Response.json({ drop: demoDrop(read, version) });
      }
    }
    if (method === 'PATCH' && url.pathname === `${base}/${DEMO_DROP_ID}/state`) {
      const body =
        typeof init?.body === 'string'
          ? JSON.parse(init.body)
          : input instanceof Request
            ? await input.json()
            : null;
      if (
        body &&
        body.read === true &&
        body.expected_version === version &&
        Object.keys(body).every((key) => key === 'read' || key === 'expected_version')
      ) {
        read = true;
        version++;
        return Response.json({ state_version: version });
      }
    }
    throw new Error(`Unscripted demo request blocked: ${method} ${url.pathname}`);
  };
}

function OpenMessage({ open }: { open: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const clickRow = () => {
      const row = root.current?.querySelector<HTMLElement>(`[data-drop-id="${DEMO_DROP_ID}"]`);
      if (!row) return false;
      row.click();
      return true;
    };
    if (clickRow()) return;
    const observer = new MutationObserver(() => {
      if (clickRow()) observer.disconnect();
    });
    if (root.current) observer.observe(root.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open]);
  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Routes>
        <Route path="/app/inbox" element={<MailboxPage view="inbox" />} />
        <Route path="/app/inbox/:dropId" element={<MailboxPage view="inbox" />} />
      </Routes>
    </div>
  );
}

function DashboardSession({ open }: { open: boolean }) {
  const [ready, setReady] = useState(false);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  useLayoutEffect(() => {
    const previousFetch = window.fetch;
    const previousLanguage = localStorage.getItem('agentdrop.lang');
    const previousH = localStorage.getItem('agentdrop.currentH');
    const transport = fixtureTransport();
    window.fetch = transport;
    localStorage.setItem('agentdrop.lang', 'en');
    localStorage.setItem('agentdrop.currentH', DEMO_H_ID);
    client.setQueryData(['me'], demoMe);
    setReady(true);
    return () => {
      client.clear();
      if (window.fetch === transport) window.fetch = previousFetch;
      for (const [key, value] of [
        ['agentdrop.lang', previousLanguage],
        ['agentdrop.currentH', previousH],
      ] as const) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    };
  }, [client]);
  return (
    <div className="demo-dashboard flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-bg text-fg">
      {ready ? (
        <QueryClientProvider client={client}>
          <SessionProvider>
            <MemoryRouter initialEntries={['/app/inbox']}>
              <OpenMessage open={open} />
            </MemoryRouter>
          </SessionProvider>
        </QueryClientProvider>
      ) : null}
    </div>
  );
}

/** Remounting on either transition makes backwards timeline seeks restore the unselected inbox. */
export function Dashboard({ open }: { open: boolean }) {
  return <DashboardSession key={open ? 'opened' : 'inbox'} open={open} />;
}
