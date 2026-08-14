/**
 * esbuild bundler for the Web client half.
 *
 * Produces `lib/client.js` as a `window.__ModuleLoader__.load({ id, factory })`
 * module — the format the shell's module loader fetches per plugin row. The
 * static modules the shell shares into the module table (react, primitives,
 * cordis, slots, …) are marked external so the bundle ships no vendored
 * runtime and every bundle sees the same instances.
 *
 * Run via `npm run build:client` (or `build`, which runs both tsc and this).
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'))

const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

await build({
  entryPoints: [resolve(here, 'src/client.ts')],
  bundle: true,
  format: 'cjs',
  // Wrap the CJS body in the module-loader envelope: the shell's loader calls
  // factory(require) and reads its exports. The banner declares the `module`
  // and `exports` locals esbuild's CJS output references.
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  },
  footer: {
    js: `\n\t\treturn module.exports;\n\t}\n});`,
  },
  external: externals,
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: resolve(here, 'lib/client.js'),
  sourcemap: true,
  logLevel: 'info',
})
