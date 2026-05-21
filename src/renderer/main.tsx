/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Sentry must be initialized first
// Use electron-specific renderer package only inside Electron; fall back to the
// browser SDK when running as a standalone web server (no window.electronAPI).
if ((window as { electronAPI?: unknown }).electronAPI) {
  // Dynamic import avoids bundling sentry-ipc:// protocol code into the web build
  import('@sentry/electron/renderer').then((Sentry) => Sentry.init()).catch(() => {});
}

// Runtime patches must be imported early
import './utils/ui/runtimePatches';

// Browser adapter setup
import '@/common/adapter/browser';

// React and core dependencies
import type { PropsWithChildren } from 'react';
import React from 'react';
import { createRoot } from 'react-dom/client';

// Context providers
import { AuthProvider } from './hooks/context/AuthContext';
import { ThemeProvider } from './hooks/context/ThemeContext';
import { PreviewProvider } from './pages/conversation/Preview/context/PreviewContext';
import { ConversationTabsProvider } from './pages/conversation/hooks/ConversationTabsContext';

// Arco Design
import { ConfigProvider } from '@arco-design/web-react';
// Configure Arco Design to use React 18's createRoot, fixing Message component's CopyReactDOM.render error
import '@arco-design/web-react/es/_util/react-19-adapter';
import '@arco-design/web-react/dist/css/arco.css';
import enUS from '@arco-design/web-react/es/locale/en-US';
import { useTranslation } from 'react-i18next';

// Styles
import 'uno.css';
import './styles/arco-override.css';
import './styles/themes/index.css';

// i18n
import './services/i18n';
import { registerPwa } from './services/registerPwa';

// Components and utilities
import AppLoader from './components/layout/AppLoader';
import Layout from './components/layout/Layout';
import Router from './components/layout/Router';
import Sider from './components/layout/Sider';
import { useAuth } from './hooks/context/AuthContext';
import { ConversationHistoryProvider } from './hooks/context/ConversationHistoryContext';
import HOC from './utils/ui/HOC';

// Lazy-load Arco locale data — only the active language is loaded.
// English (enUS) is always bundled as the fallback; others load on demand.
type ArcoLocale = typeof enUS;

const localeLoaders: Record<string, () => Promise<{ default: ArcoLocale }>> = {
  'zh-CN': () => import('@arco-design/web-react/es/locale/zh-CN'),
  'zh-TW': () => import('@arco-design/web-react/es/locale/zh-TW'),
  'ja-JP': () => import('@arco-design/web-react/es/locale/ja-JP'),
  'ko-KR': () => import('@arco-design/web-react/es/locale/ko-KR'),
};

// Cache loaded locales to avoid re-importing
const loadedLocales: Record<string, ArcoLocale> = { 'en-US': enUS };

function useArcoLocale(): ArcoLocale {
  const {
    i18n: { language },
  } = useTranslation();
  const [locale, setLocale] = React.useState<ArcoLocale>(loadedLocales[language] ?? enUS);

  React.useEffect(() => {
    if (loadedLocales[language]) {
      setLocale(loadedLocales[language]);
      return;
    }
    const loader = localeLoaders[language];
    if (!loader) return;

    let cancelled = false;
    void loader().then((mod) => {
      if (cancelled) return;
      let arcoLocale = mod.default;
      // Patch Korean locale with missing properties from English
      if (language === 'ko-KR') {
        arcoLocale = {
          ...arcoLocale,
          Calendar: { ...arcoLocale.Calendar, monthFormat: enUS.Calendar.monthFormat, yearFormat: enUS.Calendar.yearFormat },
          DatePicker: { ...arcoLocale.DatePicker, Calendar: { ...arcoLocale.DatePicker.Calendar, monthFormat: enUS.Calendar.monthFormat, yearFormat: enUS.Calendar.yearFormat } },
          Form: enUS.Form,
          ColorPicker: enUS.ColorPicker,
        } as ArcoLocale;
      }
      loadedLocales[language] = arcoLocale;
      setLocale(arcoLocale);
    });
    return () => { cancelled = true; };
  }, [language]);

  return locale;
}

const AppProviders: React.FC<PropsWithChildren> = ({ children }) =>
  React.createElement(
    AuthProvider,
    null,
    React.createElement(
      ThemeProvider,
      null,
      React.createElement(PreviewProvider, null, React.createElement(ConversationTabsProvider, null, children))
    )
  );

const Config: React.FC<PropsWithChildren> = ({ children }) => {
  const arcoLocale = useArcoLocale();
  return React.createElement(ConfigProvider, { theme: { primaryColor: '#4E5969' }, locale: arcoLocale }, children);
};

const Main = () => {
  const { ready } = useAuth();

  if (!ready) {
    return <AppLoader />;
  }

  return (
    <Router
      layout={
        <ConversationHistoryProvider>
          <Layout sider={<Sider />} />
        </ConversationHistoryProvider>
      }
    />
  );
};

const App = HOC.Wrapper(Config)(Main);

void registerPwa();

const root = createRoot(document.getElementById('root')!);
root.render(React.createElement(AppProviders, null, React.createElement(App)));
