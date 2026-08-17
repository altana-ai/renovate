import { z } from 'zod/v4';
import { logger } from '../../../logger/index.ts';
import { Result } from '../../../util/result.ts';
import { parse as parseToml } from '../../../util/toml.ts';
import type { PantsResolveConfig, PantsTargetType } from './types.ts';

// `[python].resolves` defaults to a single `python-default` resolve, and
// `[python].default_resolve` to its name, so a repository that enables
// resolves without naming any still has one.
const defaultResolveName = 'python-default';

const PantsToml = z.object({
  python: z
    .object({
      enable_resolves: z.boolean().optional(),
      default_resolve: z.string().optional(),
      resolves: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/**
 * Reads the resolve configuration out of `pants.toml`.
 *
 * Only `pants.toml` is read. Pants layers `pants.<name>.toml` files listed in
 * `[GLOBAL] pants_config_files`, `PANTS_*` environment variables and command
 * line flags on top of it, and supports `%(placeholder)s` interpolation, none
 * of which are visible here.
 */
export function parsePantsToml(content: string): PantsResolveConfig {
  const { val: parsed, err } = Result.wrap(() =>
    PantsToml.parse(parseToml(content)),
  ).unwrap();

  if (err) {
    logger.debug({ err }, 'pants: could not parse pants.toml');
  }

  const python = parsed?.python;
  return {
    enableResolves: python?.enable_resolves === true,
    defaultResolve: python?.default_resolve ?? defaultResolveName,
    lockfiles: python?.resolves ?? {},
  };
}

/**
 * The `resolve` values in effect for each target type in one directory.
 *
 * `__defaults__` applies to every target in its own build file and, unless a
 * nearer build file overrides it, to every target below it. `all=` sets the
 * field for every target type, and without `extend=True` a call replaces the
 * inherited defaults rather than merging with them.
 */
export type ResolveScope = PantsTargetType | 'all';

export type ResolveDefaults = Partial<Record<ResolveScope, string[]>>;

export interface DefaultsCall {
  extend: boolean;
  /**
   * The `resolve` values the call sets, keyed by the target type they are
   * scoped to. A `resolve=` outside any per-type mapping — which is how `all=`
   * is written — lands under `all`.
   */
  resolves: ResolveDefaults;
}

export function applyDefaultsCalls(
  inherited: ResolveDefaults,
  calls: DefaultsCall[],
): ResolveDefaults {
  let current: ResolveDefaults = inherited;
  for (const call of calls) {
    // Without `extend=True` a call replaces the inherited defaults rather than
    // merging with them, so a call that sets no `resolve` still drops one that
    // an ancestor build file set.
    current = call.extend
      ? { ...current, ...call.resolves }
      : { ...call.resolves };
  }
  return current;
}

/**
 * Walks from a build file's own directory up to the repository root, returning
 * the first defaults found. Pants inherits from the nearest ancestor build
 * file, whose own defaults already include what it inherited.
 */
export function inheritedDefaults(
  packageFile: string,
  defaultsByDir: Map<string, ResolveDefaults>,
): ResolveDefaults {
  const parts = packageFile.split('/').slice(0, -1);
  while (parts.length) {
    parts.pop();
    const dir = parts.join('/');
    const defaults = defaultsByDir.get(dir);
    if (defaults) {
      return defaults;
    }
  }
  return {};
}
