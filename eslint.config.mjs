import { defineConfig } from 'eslint/config'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier/flat'

const sourceFiles = ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}']
const typeScriptFiles = ['**/*.{ts,mts,cts,tsx}']
const reactFiles = [
  'apps/desktop/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
  'apps/web/src/**/*.{jsx,tsx}',
  'packages/ui/{src,examples,test}/**/*.{jsx,tsx}'
]
const browserFiles = [
  'apps/desktop/src/frontend/**/*.{js,jsx,ts,tsx}',
  'apps/web/src/**/*.{js,jsx,ts,tsx}',
  'packages/ui/{src,examples,test}/**/*.{js,jsx,ts,tsx}'
]

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-ssr/**',
      '**/dist-examples/**',
      '**/out/**',
      '**/.test-dist/**',
      '**/coverage/**',
      'apps/desktop/src/frontend/public/ocr/**',
      'packages/ui/src/seed/**'
    ]
  },
  { files: sourceFiles, extends: [eslint.configs.recommended] },
  { files: typeScriptFiles, extends: [tseslint.configs.recommended] },
  {
    files: sourceFiles,
    rules: { curly: ['error', 'all'] }
  },
  { files: sourceFiles, ignores: browserFiles, languageOptions: { globals: globals.node } },
  { files: browserFiles, languageOptions: { globals: globals.browser } },
  {
    files: reactFiles,
    extends: [react.configs.flat.recommended, react.configs.flat['jsx-runtime']],
    settings: { react: { version: 'detect' } }
  },
  {
    files: [
      'apps/desktop/**/*.{ts,tsx}',
      'apps/web/src/**/*.{js,jsx,ts,tsx}',
      'packages/ui/{src,examples,test}/**/*.{js,jsx,ts,tsx}'
    ],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules, ...reactRefresh.configs.vite.rules }
  },
  // Preserve the Electron preset's static checks, including its JavaScript scope.
  {
    files: ['apps/desktop/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowIIFEs: true
        }
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTaggedTemplates: true, allowTernary: true }
      ]
    }
  },
  {
    files: ['apps/desktop/*.{js,mjs}'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  // Prettier only conflicts with curly's multi-line/minimum-size options, not all.
  { ...prettier, rules: { ...prettier.rules, curly: ['error', 'all'] } }
)
