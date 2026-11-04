import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is needed so Nest decorator metadata (constructor injection) is emitted under vitest.
export default defineConfig({
  test: { testTimeout: 30000, hookTimeout: 60000 },
  plugins: [swc.vite({ jsc: { target: 'es2022', parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
});
