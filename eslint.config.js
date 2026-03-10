import pluginVue from 'eslint-plugin-vue'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import vueParser from 'vue-eslint-parser'

export default [
    {
        ignores: ['dist/**', 'node_modules/**', 'src-tauri/**'],
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
            'vue/html-indent': 'off',
            'vue/singleline-html-element-content-newline': 'off',
            'vue/max-attributes-per-line': 'off',
            'vue/first-attribute-linebreak': 'off',
            'vue/html-closing-bracket-newline': 'off',
        },
    },
    {
        files: ['src/**/__tests__/**/*.ts'],
        rules: {
            'vue/one-component-per-file': 'off',
            'no-console': 'off',
        },
    },
]
