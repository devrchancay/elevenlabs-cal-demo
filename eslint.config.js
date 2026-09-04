import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // Vite writes its manifest and assets here; nothing in it is ours.
      'web/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Backend and scripts run on Node.
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', '*.ts', '*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // The static site runs in a browser.
  {
    files: ['web/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
);
