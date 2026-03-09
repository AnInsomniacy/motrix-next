import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import VueI18nPlugin from '@intlify/unplugin-vue-i18n/vite'
import { resolve } from 'path'

const host = process.env.TAURI_DEV_HOST

export default defineConfig(async () => ({
  plugins: [
    vue(),
    UnoCSS(),
    VueI18nPlugin({
      include: resolve(__dirname, 'src/shared/locales/**'),
      runtimeOnly: true,
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  clearScreen: false,
  esbuild: {
    logOverride: { 'js-comment-in-css': 'silent' },
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'naive-ui': ['naive-ui'],
          'tauri-api': [
            '@tauri-apps/api',
            '@tauri-apps/plugin-shell',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-clipboard-manager',
            '@tauri-apps/plugin-updater',
          ],
          'vue-vendor': ['vue', 'vue-router', 'pinia', 'vue-i18n'],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: 'ws',
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
}))
