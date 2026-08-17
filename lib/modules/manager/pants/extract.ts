import upath from 'upath';
import { logger } from '../../../logger/index.ts';
import { getSiblingFileName, readLocalFile } from '../../../util/fs/index.ts';
import { extractPackageFile as extractPyProjectFile } from '../pep621/extract.ts';
import { extractPackageFile as extractRequirementsFile } from '../pip_requirements/extract.ts';
import { extractPackageFile as extractPoetryFile } from '../poetry/extract.ts';
import type {
  ExtractConfig,
  PackageDependency,
  PackageFile,
  PackageFileContent,
} from '../types.ts';
import { parse } from './parser.ts';
import type { ResolveDefaults } from './resolves.ts';
import {
  applyDefaultsCalls,
  inheritedDefaults,
  parsePantsToml,
} from './resolves.ts';
import type {
  PantsManagerData,
  PantsParseResult,
  PantsResolveConfig,
  PantsTarget,
  PantsTargetType,
  ResolveSource,
} from './types.ts';

const defaultSources: Record<PantsTargetType, string> = {
  python_requirement: '',
  python_requirements: 'requirements.txt',
  poetry_requirements: 'pyproject.toml',
  uv_requirements: 'pyproject.toml',
};

function isBuildFile(packageFile: string): boolean {
  return upath.basename(packageFile).startsWith('BUILD');
}

/**
 * A generator's `source` can be a pip requirements file, or a `pyproject.toml`
 * in PEP 621, Poetry or uv form, so the file's own content decides the
 * extractor. Deciding on content rather than on which target pointed at the
 * file keeps extraction and re-extraction — which only knows the filename —
 * from ever disagreeing.
 */
function extractSourceFile(
  content: string,
  packageFile: string,
): Promise<PackageFileContent | null> | PackageFileContent | null {
  if (upath.basename(packageFile) !== 'pyproject.toml') {
    return extractRequirementsFile(content);
  }
  return content.includes('[tool.poetry')
    ? extractPoetryFile(content, packageFile)
    : extractPyProjectFile(content, packageFile);
}

/**
 * Turns one PEP 508 requirement string into a dependency by reusing the
 * `pip_requirements` line parser, so extras, environment markers and VCS
 * requirements behave identically in both managers.
 */
function toDep(requirement: string): PackageDependency | null {
  const dep = extractRequirementsFile(requirement)?.deps?.[0];
  if (!dep?.depName) {
    return null;
  }
  return {
    ...dep,
    depType: 'python_requirement',
    // The bare version range repeats across targets in a big BUILD file; the
    // whole requirement string is what makes the replacement unambiguous.
    replaceString: requirement,
  };
}

interface ResolveInfo {
  resolves: string[];
  resolveSource: ResolveSource;
  lockFiles: string[];
}

/**
 * The resolves a target's requirements land in: its own `resolve` field, else
 * the `__defaults__` in effect for its directory, else `[python]
 * default_resolve`. A generator moves its `resolve` onto every requirement it
 * generates, so one rule covers both kinds of target.
 */
function resolveInfo(
  target: PantsTarget,
  defaults: ResolveDefaults,
  config: PantsResolveConfig,
): ResolveInfo {
  let resolves = target.resolves;
  let resolveSource: ResolveSource = 'field';

  if (!resolves?.length) {
    resolves = defaults[target.type] ?? defaults.all;
    resolveSource = 'defaults';
  }
  if (!resolves?.length) {
    resolves = [config.defaultResolve];
    resolveSource = 'default_resolve';
  }

  const lockFiles = resolves
    .map((resolve) => config.lockfiles[resolve])
    .filter((lockFile): lockFile is string => !!lockFile);

  return { resolves, resolveSource, lockFiles };
}

/**
 * Records the resolves on the dependency itself. `lockFiles` is a package file
 * level field, so the exact per-dependency mapping has to travel as manager
 * data: `updateArtifacts` receives it on each updated dependency and can turn
 * it back into `pants generate-lockfiles --resolve=` arguments.
 */
function withResolveInfo(
  dep: PackageDependency,
  info: ResolveInfo,
  enableResolves: boolean,
): PackageDependency<PantsManagerData> {
  if (!enableResolves) {
    return dep;
  }
  return {
    ...dep,
    managerData: {
      ...(dep.managerData as PantsManagerData | undefined),
      resolves: info.resolves,
      resolveSource: info.resolveSource,
      lockFiles: info.lockFiles,
    },
  };
}

/**
 * Unions another target's resolves into a source file already extracted for a
 * previous target.
 */
function addResolves(
  packageFile: PackageFile,
  info: ResolveInfo,
  enableResolves: boolean,
): void {
  if (!enableResolves) {
    return;
  }
  for (const dep of packageFile.deps) {
    // Annotated by `withResolveInfo` when the file was first extracted, which
    // ran under the same `enableResolves`.
    const managerData = dep.managerData as Required<
      Pick<PantsManagerData, 'resolves' | 'lockFiles'>
    >;
    dep.managerData = {
      ...managerData,
      resolves: [...new Set([...managerData.resolves, ...info.resolves])],
      lockFiles: [...new Set([...managerData.lockFiles, ...info.lockFiles])],
    };
  }
  if (info.lockFiles.length) {
    packageFile.lockFiles = [
      ...new Set([...(packageFile.lockFiles ?? []), ...info.lockFiles]),
    ];
  }
}

function extractInlineDeps(
  targets: PantsTarget[],
  defaults: ResolveDefaults,
  config: PantsResolveConfig,
): PackageDependency[] {
  const deps: PackageDependency[] = [];
  for (const target of targets) {
    if (target.type !== 'python_requirement') {
      continue;
    }
    const info = resolveInfo(target, defaults, config);
    for (const { value } of target.requirements) {
      const dep = toDep(value);
      if (dep) {
        deps.push(withResolveInfo(dep, info, config.enableResolves));
      } else {
        logger.debug(
          { requirement: value, target: target.name },
          'pants: skipping unparseable requirement',
        );
      }
    }
  }
  return deps;
}

/** Stand-in for a repository that does not enable resolves. */
const noResolves: PantsResolveConfig = {
  enableResolves: false,
  defaultResolve: 'python-default',
  lockfiles: {},
};

async function readResolveConfig(): Promise<PantsResolveConfig> {
  const content = await readLocalFile('pants.toml', 'utf8');
  if (!content) {
    logger.debug('pants: no pants.toml found, resolves not annotated');
    return noResolves;
  }
  return parsePantsToml(content);
}

export async function extractPackageFile(
  content: string,
  packageFile: string,
  _config?: ExtractConfig,
): Promise<PackageFileContent | null> {
  // A generator target points at a source file which is returned as its own
  // package file, so re-extraction lands here too.
  if (!isBuildFile(packageFile)) {
    return await extractSourceFile(content, packageFile);
  }

  // Resolve annotation needs the whole build file tree. A single-file
  // extraction — which is also the auto-replace confirmation path — therefore
  // annotates nothing, and only the dependencies have to match.
  const { targets, defaults } = parse(content);
  const deps = extractInlineDeps(
    targets,
    applyDefaultsCalls({}, defaults),
    noResolves,
  );
  return deps.length ? { deps } : null;
}

export async function extractAllPackageFiles(
  _config: ExtractConfig,
  packageFiles: string[],
): Promise<PackageFile[]> {
  const resolveConfig = await readResolveConfig();

  // `__defaults__` is inherited from the nearest ancestor build file, so every
  // build file has to be parsed before any of them can be annotated.
  const parsed = new Map<string, PantsParseResult>();
  for (const packageFile of packageFiles) {
    const content = await readLocalFile(packageFile, 'utf8');
    if (!content) {
      logger.debug({ packageFile }, 'pants: could not read file');
      continue;
    }
    parsed.set(packageFile, parse(content));
  }

  const ownDefaults = new Map<string, ResolveDefaults>();
  for (const [packageFile, { defaults }] of parsed) {
    if (defaults.length) {
      ownDefaults.set(
        upath.dirname(packageFile),
        applyDefaultsCalls({}, defaults),
      );
    }
  }

  const result: PackageFile[] = [];
  // A source file may be shared by several targets, and by several build
  // files — extract it once, and remember it so that another target pointing
  // at it only adds its resolves.
  const sourceFiles = new Map<string, PackageFile>();

  for (const [packageFile, { targets, defaults }] of parsed) {
    const effectiveDefaults = applyDefaultsCalls(
      inheritedDefaults(packageFile, ownDefaults),
      defaults,
    );

    const deps = extractInlineDeps(targets, effectiveDefaults, resolveConfig);
    if (deps.length) {
      // One build file can hold requirements for several resolves, so the file
      // level `lockFiles` is their union; `managerData.lockFiles` keeps the
      // per-dependency truth.
      const lockFiles = [
        ...new Set(
          deps.flatMap(
            (dep) =>
              (dep.managerData as PantsManagerData | undefined)?.lockFiles ??
              [],
          ),
        ),
      ];
      result.push({
        packageFile,
        deps,
        ...(lockFiles.length ? { lockFiles } : {}),
      });
    }

    for (const target of targets) {
      if (target.type === 'python_requirement') {
        continue;
      }
      const source = getSiblingFileName(
        packageFile,
        target.source?.value ?? defaultSources[target.type],
      );
      const info = resolveInfo(target, effectiveDefaults, resolveConfig);

      const already = sourceFiles.get(source);
      if (already) {
        // Two generator targets can share one source and put it in different
        // resolves; the requirements are the same, so only the resolves union.
        addResolves(already, info, resolveConfig.enableResolves);
        continue;
      }

      const sourceContent = await readLocalFile(source, 'utf8');
      if (!sourceContent) {
        logger.debug(
          { packageFile, source, target: target.type },
          'pants: generator source not found',
        );
        continue;
      }

      const extracted = await extractSourceFile(sourceContent, source);
      if (extracted?.deps?.length) {
        const packageFileResult: PackageFile = {
          ...extracted,
          packageFile: source,
          ...(resolveConfig.enableResolves && info.lockFiles.length
            ? { lockFiles: info.lockFiles }
            : {}),

          deps: extracted.deps.map((dep) =>
            withResolveInfo(
              {
                ...dep,
                // Keep the delegate's own depType where it has one — `pep621`
                // and `poetry` distinguish dependency groups, and that detail
                // is worth more in `packageRules` than uniformity.
                depType: dep.depType ?? target.type,
              },
              info,
              resolveConfig.enableResolves,
            ),
          ),
        };
        sourceFiles.set(source, packageFileResult);
        result.push(packageFileResult);
      }
    }
  }

  return result;
}
