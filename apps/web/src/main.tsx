import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
// Bundled fonts: the CSP allows only this origin, so a font CDN would never load in production.
import '@fontsource-variable/manrope';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './index.css';
import { syncLangForNotifications } from './lib/lang.js';
import { noteOwnMutation } from './lib/live.js';
import { SessionProvider } from './lib/session.js';
import { AgentsPage } from './pages/agents.jsx';
import { LoginPage, SignupPage } from './pages/auth.jsx';
import { ComposePage } from './pages/compose.jsx';
import { ContactsPage } from './pages/contacts.jsx';
import { GroupsPage } from './pages/groups.jsx';
import { HelpPage } from './pages/help.jsx';
import { InvitePage } from './pages/invite.jsx';
import { MailboxPage } from './pages/mailbox.jsx';
import { ApprovalsPage, ConnectionsPage, SettingsPage } from './pages/misc.jsx';
import { PairPage } from './pages/pair.jsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/password-reset.jsx';
import { AppShell } from './pages/shell.jsx';
import { SpacePage } from './pages/space.jsx';
import { PublicPageTitle } from './ui/document-title.jsx';
import { PageErrorBoundary } from './ui/error-boundary.jsx';
import { NotificationNavigation } from './ui/notification-navigation.jsx';

// Loaded on first visit: the landing page is for people who are not signed in, the console for administrators;
// neither belongs in the bundle every signed-in person downloads.
const LandingPage = lazy(() => import('./pages/landing.jsx').then((m) => ({ default: m.LandingPage })));
const AdminPage = lazy(() => import('./pages/admin.jsx').then((m) => ({ default: m.AdminPage })));

/** The console, loaded with the first admin page opened. */
function Admin({ section }: { section: 'overview' | 'users' | 'audit' | 'settings' }) {
  return (
    <Suspense fallback={null}>
      <AdminPage section={section} />
    </Suspense>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 2_000 } },
  // Runs before each mutation's own onSuccess refetches: the event stream then knows its echo (lib/live.ts).
  mutationCache: new MutationCache({ onSuccess: () => noteOwnMutation() }),
});

syncLangForNotifications();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <BrowserRouter>
          <NotificationNavigation />
          <PublicPageTitle />
          <PageErrorBoundary>
            <Routes>
              <Route
                path="/"
                element={
                  <Suspense fallback={null}>
                    <LandingPage />
                  </Suspense>
                }
              />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/signup" element={<SignupPage />} />
              <Route path="/pair" element={<PairPage />} />
              <Route path="/invite/:token" element={<InvitePage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/app" element={<AppShell />}>
                <Route index element={<Navigate to="/app/inbox" replace />} />
                <Route path="inbox" element={<MailboxPage view="inbox" />} />
                <Route path="inbox/:dropId" element={<MailboxPage view="inbox" />} />
                <Route path="sent" element={<MailboxPage view="sent" />} />
                <Route path="sent/:dropId" element={<MailboxPage view="sent" />} />
                <Route path="starred" element={<MailboxPage view="starred" />} />
                <Route path="starred/:dropId" element={<MailboxPage view="starred" />} />
                <Route path="archived" element={<MailboxPage view="archived" />} />
                <Route path="archived/:dropId" element={<MailboxPage view="archived" />} />
                <Route path="space" element={<SpacePage />} />
                <Route path="compose" element={<ComposePage />} />
                <Route path="contacts" element={<ContactsPage />} />
                <Route path="contacts/:userId" element={<ContactsPage />} />
                <Route path="groups" element={<GroupsPage />} />
                <Route path="groups/:groupId" element={<GroupsPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="connections" element={<ConnectionsPage />} />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="approvals/:approvalId" element={<ApprovalsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="help" element={<HelpPage />} />
                <Route path="admin" element={<Admin section="overview" />} />
                <Route path="admin/users" element={<Admin section="users" />} />
                <Route path="admin/users/:id" element={<Admin section="users" />} />
                <Route path="admin/audit" element={<Admin section="audit" />} />
                <Route path="admin/settings" element={<Admin section="settings" />} />
              </Route>
              <Route path="/approvals/:approvalId" element={<Navigate to="/app/approvals" replace />} />
              <Route path="*" element={<Navigate to="/app/inbox" replace />} />
            </Routes>
          </PageErrorBoundary>
        </BrowserRouter>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
