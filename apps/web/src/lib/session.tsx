import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, type Endpoint, type Me } from './api.js';
import { cleanupBrowserPushBeforeSignOut } from './push.js';

interface SessionState {
  me: Me | null;
  loading: boolean;
  currentH: Endpoint | null;
  setCurrentH: (hId: string) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);
const STORAGE_KEY = 'agentdrop.currentH';

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/v1/me');
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 10_000,
    retry: false,
  });
  const me = meQuery.data ?? null;
  const [hId, setHId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));

  const active = useMemo(() => (me?.endpoints ?? []).filter((e) => !e.revoked_at), [me]);
  const currentH = useMemo(() => {
    if (!me) return null;
    return (
      active.find((e) => e.h_id === hId) ?? active.find((e) => e.is_default_receiver) ?? active[0] ?? null
    );
  }, [me, active, hId]);

  useEffect(() => {
    if (currentH && currentH.h_id !== hId) {
      setHId(currentH.h_id);
      localStorage.setItem(STORAGE_KEY, currentH.h_id);
    }
  }, [currentH, hId]);

  const value: SessionState = {
    me,
    loading: meQuery.isLoading,
    currentH,
    setCurrentH: (id) => {
      // switching H drops every cached mailbox view of the previous H: nothing from it may flash into the new view
      qc.removeQueries({ queryKey: ['mailbox'] });
      localStorage.setItem(STORAGE_KEY, id);
      setHId(id);
    },
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    signOut: async () => {
      await cleanupBrowserPushBeforeSignOut(me?.user_id);
      await fetch('/api/auth/sign-out', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      qc.clear();
      localStorage.removeItem(STORAGE_KEY);
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('SessionProvider missing');
  return v;
}

/** Mailbox query keys always include the H so views of different endpoints never share cache entries. */
export function mailboxKey(hId: string, ...rest: unknown[]): unknown[] {
  return ['mailbox', hId, ...rest];
}

export function useFocusAwareInterval(): number {
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible ? 10_000 : 60_000;
}
