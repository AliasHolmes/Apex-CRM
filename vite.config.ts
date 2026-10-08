import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      // Keep runtime-generated files ignored: Vite broadcasts full-reload for any
      // watched change that is not in the module graph (needFullReload when the file
      // maps to zero modules), so SQLite WAL/SHM, logs, and temp files must never
      // reach the watcher. See docs/adr/0010-dev-server-hmr-reload-containment.md.
      watch: process.env.DISABLE_HMR === 'true' ? null : {
        ignored: [
          '**/.apex-data/**',
          '**/test/**',
          '**/docs/**',
          '**/*.sqlite*',
          '**/*.log',
          '**/*.tmp',
          '**/*.bak',
          '**/scratch/**',
        ]
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        '@tanstack/react-table',
        '@tanstack/react-virtual',
        'react-markdown',
        'remark-gfm',
        'lucide-react',
        'motion/react',
        'papaparse',
        '@radix-ui/react-dialog',
        '@radix-ui/react-label',
        '@radix-ui/react-slot',
        '@radix-ui/react-tabs',
        '@radix-ui/react-select',
        '@radix-ui/react-popover',
        '@radix-ui/react-tooltip',
        '@radix-ui/react-checkbox',
        '@radix-ui/react-dropdown-menu',
        '@radix-ui/react-separator',
        '@dnd-kit/core',
        '@dnd-kit/sortable',
        '@dnd-kit/utilities',
        'recharts',
        'class-variance-authority',
        'clsx',
        'tailwind-merge'
      ]
    },
    build: {
      target: 'esnext'
    }
  };
});
