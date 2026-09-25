import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import prettierPlugin from 'eslint-plugin-prettier'
import globals from 'globals'

/**
 * Flat config for ESLint 9.
 *
 * The previous `.eslintrc.json` extended `xo`, which was never installed, and
 * ESLint 9 ignores eslintrc files by default — so linting silently did nothing.
 */
export default [
    { ignores: ['node_modules/', 'sessions/'] },
    js.configs.recommended,
    prettierConfig,
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            prettier: prettierPlugin,
        },
        rules: {
            'prettier/prettier': 'error',
            'max-params': ['error', 5],
            'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
        },
    },
]
