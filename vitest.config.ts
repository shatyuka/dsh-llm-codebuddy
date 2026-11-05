import ts from 'typescript'
import { defineConfig } from 'vitest/config'

/**
 * Oxc passes `@Remote` through unchanged and Node's ESM loader then rejects it,
 * so only files carrying the syntax are rewritten here.
 * @returns the pre-transform Vite plugin.
 */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-llm-codebuddy-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/u.test(file) || !/^\s*@[A-Za-z_$]/mu.test(code)) return
      const { outputText, sourceMapText } = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, sourceMap: true },
      })
      return { code: outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: sourceMapText }
    },
  }
}

/**
 * Test runner configuration.
 *
 * The suite runs Node-side only: the Host half is plain Node ESM, and the
 * client-side modules under test (`units`, `model-order`, `model-badges`,
 * `prefs`) are deliberately runtime-free — no JSX, no DOM, no React render
 * tree — so they import under Node exactly as the Host does. No browser
 * environment is configured because nothing under test needs one.
 *
 * `pool: 'forks'` is deliberate, not a default: V8 has aborted in its CJS
 * lexer from worker threads on macOS, Linux, and Windows, so a threaded pool
 * shares a path that can crash the runner. Forked workers avoid it.
 *
 * Tests import sources with the shipped `.js` specifiers, which Vite's resolver
 * maps back to the `.ts` files; that keeps a test importing the same specifiers
 * the package itself publishes.
 */
export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
    // Mocks and global stubs are per-test tools here. `restoreMocks` resets a
    // mock's behaviour before each test, so a `mockReturnValueOnce` cannot leak
    // from one test into the next; each file still gets its own module registry
    // and worker, which is what keeps files independent.
    restoreMocks: true,
    unstubGlobals: true,
  },
})
