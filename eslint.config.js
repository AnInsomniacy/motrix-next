import pluginVue from 'eslint-plugin-vue'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import vueParser from 'vue-eslint-parser'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import { INDIRECT_I18N_KEYS } from './scripts/i18n-key-contracts.mjs'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**'],
  },
  ...vueI18n.configs.base,
  {
    settings: {
      'vue-i18n': {
        localeDir: {
          pattern: './src/shared/locales/*/messages.json',
          localeKey: 'path',
          localePattern: /^.*\/locales\/(?<locale>[^/]+)\/messages\.json$/u,
        },
        messageSyntaxVersion: '^11.0.0',
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'vue/multi-word-component-names': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      '@intlify/vue-i18n/no-missing-keys': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@intlify/vue-i18n/no-missing-keys': 'error',
    },
  },
  {
    files: ['src/shared/locales/*/messages.json'],
    rules: {
      '@intlify/vue-i18n/no-duplicate-keys-in-locale': 'error',
      '@intlify/vue-i18n/no-missing-keys-in-other-locales': 'error',
      '@intlify/vue-i18n/valid-message-syntax': 'error',
    },
  },
  {
    files: ['src/shared/locales/en-US/messages.json'],
    rules: {
      '@intlify/vue-i18n/no-unused-keys': [
        'error',
        {
          src: './src',
          extensions: ['.ts', '.vue'],
          ignores: INDIRECT_I18N_KEYS,
          enableFix: false,
        },
      ],
    },
  },
  eslintConfigPrettier,
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    rules: {
      'no-console': 'off',
      'vue/one-component-per-file': 'off',
    },
  },
]
