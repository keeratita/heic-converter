import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const GENERATED_IGNORES = [
  'dist/',
  'node_modules/',
  'build-wasm/',
  'coverage/',
  // Generated Emscripten glue (regenerate with `npm run build:wasm`).
  'src/wasm/wrapper/heic-decoder.js',
];

export default tseslint.config(
  { ignores: GENERATED_IGNORES },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Library source must stay environment-agnostic: only ECMAScript globals.
      globals: {
        ...globals.es2022,
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    }
  },
  {
    // Test harnesses and the browser sandbox run in Node and the browser.
    files: ['test/**/*.{ts,js,mjs}', 'docs/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      }
    }
  },
  {
    // Build-time scripts run in Node only.
    files: ['build-scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      }
    }
  }
);
