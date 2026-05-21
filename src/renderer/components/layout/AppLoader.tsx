/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Lightweight app-level loading skeleton displayed while:
 * - Auth state is being resolved (initial mount)
 * - Lazy-loaded route components are fetching their chunks
 *
 * Uses pure inline styles (no Arco / UnoCSS dependency) to keep the critical
 * path minimal and avoid FOUC when the CSS bundle hasn't loaded yet.
 */
const AppLoader: React.FC = () => {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        minHeight: '100vh',
        background: 'var(--bg-base, transparent)',
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          border: '3px solid var(--bg-3, #e5e6eb)',
          borderTopColor: 'var(--primary, #4E5969)',
          animation: 'app-loader-spin 0.8s linear infinite',
        }}
      />
      <style>{`@keyframes app-loader-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

export default AppLoader;
