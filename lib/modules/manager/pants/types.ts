import type { DefaultsCall } from './resolves.ts';

export type PantsTargetType =
  | 'python_requirement'
  | 'python_requirements'
  | 'poetry_requirements'
  | 'uv_requirements';

export interface PantsToken {
  value: string;
  line: number;
}

export interface PantsTarget {
  type: PantsTargetType;
  /** The target's `name=`, when given. */
  name?: string;
  /** `python_requirement(requirements=[...])` entries, as PEP 508 strings. */
  requirements: PantsToken[];
  /** A generator's `source=...`, relative to the build file. */
  source?: PantsToken;
  /** `resolve="x"` or `resolve=parametrize("x", "y")`, when given. */
  resolves?: string[];
}

export interface PantsParseResult {
  targets: PantsTarget[];
  defaults: DefaultsCall[];
}

export interface PantsResolveConfig {
  /** `[python] enable_resolves`; without it there are no per-resolve lockfiles. */
  enableResolves: boolean;
  /** `[python] default_resolve`. */
  defaultResolve: string;
  /** `[python.resolves]`: resolve name to lockfile path. */
  lockfiles: Record<string, string>;
}

/** Where a dependency's resolves were determined from. */
export type ResolveSource = 'field' | 'defaults' | 'default_resolve';

export interface PantsManagerData {
  /** Names of the resolves this requirement belongs to. */
  resolves?: string[];
  resolveSource?: ResolveSource;
  /** The lockfiles of those resolves, from `[python.resolves]`. */
  lockFiles?: string[];
}
