/**
 * Minimal client-side type shims for faces the shell provides at runtime
 * while this plugin consumes them as structural types only.
 *
 * The esbuild bundle marks `@deepseek-ai/dsh-client-ui-primitives` external
 * (the shell's static module table provides it); the slot system's
 * `SnapshotStore` type ships in `@deepseek-ai/dsh-client-store`, a package
 * this plugin keeps off its dependency list — the structural subset the
 * components use is declared here, and the runtime value is the shell's
 * real store either way.
 *
 * @module dsh-llm-codebuddy/client-types
 */

/** Structural subset of the shell's `SnapshotStore<T>` used by client UIs. */
export interface SnapshotStore<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}
