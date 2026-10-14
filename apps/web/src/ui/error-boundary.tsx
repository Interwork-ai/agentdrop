import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../lib/lang.js';
import { Button } from './primitives.jsx';

/**
 * A page that throws while rendering must not take the whole dashboard down with it: without this, React unmounts
 * everything and the person sees a blank dark screen with no way back (the compose page did exactly that on plain
 * http, where `crypto.randomUUID` is missing). The shell keys it by path, so moving to another page recovers.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is the only place the cause is kept; nothing received is shown to the person.
    console.error('page failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto w-full max-w-xl space-y-3 p-6 text-sm md:pt-16">
        <h1 className="text-md font-semibold text-fg">
          {t('This page could not be shown', '这个页面没能显示出来')}
        </h1>
        <p className="leading-6 text-fg-2">
          {t(
            'Something went wrong while opening it. Nothing you already sent is affected. Reload the page, or pick another page on the left.',
            '打开时出了错，已经发出的内容不受影响。请刷新页面，或从左侧换到其他页面。',
          )}
        </p>
        <Button onClick={() => window.location.reload()}>{t('Reload', '刷新')}</Button>
      </div>
    );
  }
}
