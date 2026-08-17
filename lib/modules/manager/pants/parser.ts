import type { lexer, parser } from '@renovatebot/good-enough-parser';
import { lang, query as q } from '@renovatebot/good-enough-parser';
import { regEx } from '../../../util/regex.ts';
import type { DefaultsCall, ResolveScope } from './resolves.ts';
import type {
  PantsParseResult,
  PantsTarget,
  PantsTargetType,
  PantsToken,
} from './types.ts';

// BUILD.pants files are evaluated by Pants as Python, so the Python grammar
// tokenizes them correctly — including comments, implicit string concatenation
// and calls such as `resolve=parametrize(...)`.
const python = lang.createLang('python');

interface Ctx {
  targets: PantsTarget[];
  defaults: DefaultsCall[];
  target?: PantsTarget;
  /** The `__defaults__` call currently being matched, if any. */
  defaultsCall?: DefaultsCall;
  /** The target types a per-type `__defaults__` mapping is scoped to. */
  defaultsScope?: string[];
  attr?: string;
}

const targetNameRegex = regEx(
  /^(?:python_requirement|python_requirements|poetry_requirements|uv_requirements)$/,
);

// Only the attributes we consume. Anything else — `module_mapping`,
// `overrides` — is skipped, so their string values can never be mistaken for
// requirements.
const attrNameRegex = regEx(/^(?:name|requirements|source|resolve)$/);

function startTarget(ctx: Ctx, name: string): Ctx {
  return {
    ...ctx,
    target: { type: name as PantsTargetType, requirements: [] },
    attr: undefined,
  };
}

function endTarget(ctx: Ctx): Ctx {
  // v8 ignore next 3 -- unreachable: the target is opened by the call matcher
  if (!ctx.target) {
    return ctx;
  }
  return {
    ...ctx,
    targets: [...ctx.targets, ctx.target],
    target: undefined,
    attr: undefined,
  };
}

function startDefaults(ctx: Ctx): Ctx {
  return {
    ...ctx,
    defaultsCall: { extend: false, resolves: {} },
    defaultsScope: undefined,
    attr: undefined,
  };
}

function endDefaults(ctx: Ctx): Ctx {
  // v8 ignore next 3 -- unreachable: the call is opened by the call matcher
  if (!ctx.defaultsCall) {
    return ctx;
  }
  return {
    ...ctx,
    defaults: [...ctx.defaults, ctx.defaultsCall],
    defaultsCall: undefined,
    defaultsScope: undefined,
    attr: undefined,
  };
}

function addScope(ctx: Ctx, alias: string): Ctx {
  return { ...ctx, defaultsScope: [...(ctx.defaultsScope ?? []), alias] };
}

function clearScope(ctx: Ctx): Ctx {
  return { ...ctx, defaultsScope: undefined };
}

function startAttr(ctx: Ctx, attr: string): Ctx {
  return { ...ctx, attr };
}

function addString(ctx: Ctx, token: lexer.StringValueToken): Ctx {
  const { target, defaultsCall, attr } = ctx;
  if (!attr) {
    // v8 ignore next 2 -- unreachable: strings only match inside an attribute
    return ctx;
  }

  if (defaultsCall) {
    // v8 ignore next 3 -- unreachable: inside a defaults call only `resolve`
    // assignments open an attribute
    if (attr !== 'resolve') {
      return ctx;
    }
    // A mapping key scopes the value to those target types; anything else —
    // including how `all=` is written — applies to every type.
    const scopes = ctx.defaultsScope ?? ['all'];
    const resolves = { ...defaultsCall.resolves };
    for (const scope of scopes) {
      resolves[scope as ResolveScope] = [
        ...(resolves[scope as ResolveScope] ?? []),
        token.value,
      ];
    }
    return { ...ctx, defaultsCall: { ...defaultsCall, resolves } };
  }

  // v8 ignore next 3 -- unreachable: a target or a defaults call is always open
  if (!target) {
    return ctx;
  }

  const value: PantsToken = { value: token.value, line: token.line };
  switch (attr) {
    case 'name':
      return { ...ctx, target: { ...target, name: value.value } };
    case 'source':
      return { ...ctx, target: { ...target, source: value } };
    case 'requirements':
      return {
        ...ctx,
        target: { ...target, requirements: [...target.requirements, value] },
      };
    case 'resolve':
      return {
        ...ctx,
        target: {
          ...target,
          resolves: [...(target.resolves ?? []), value.value],
        },
      };
    // v8 ignore next 2 -- unreachable: attrNameRegex allows nothing else
    default:
      return ctx;
  }
}

function setExtend(ctx: Ctx, value: string): Ctx {
  const { defaultsCall } = ctx;
  // v8 ignore next 3 -- unreachable: only matched inside a defaults call
  if (!defaultsCall) {
    return ctx;
  }
  return {
    ...ctx,
    defaultsCall: { ...defaultsCall, extend: value === 'True' },
  };
}

const stringValue = q.str<Ctx>(addString);

const stringList = q.tree<Ctx>({
  type: 'wrapped-tree',
  maxDepth: 1,
  startsWith: '[',
  endsWith: ']',
  search: q.many(stringValue),
});

/**
 * `resolve=parametrize("a", "b")` puts one requirement in several resolves.
 * Only positional arguments name resolves; the keyword form builds parametrize
 * groups over other fields.
 */
const parametrizeCall = q.sym<Ctx>('parametrize').join(
  q.tree({
    type: 'wrapped-tree',
    maxDepth: 1,
    search: q.many(stringValue),
  }),
);

const attributeValue = q.alt<Ctx>(stringValue, stringList, parametrizeCall);

/**
 * Matches a target attribute holding a string, a list of strings or a
 * `parametrize(...)` call:
 * - `name = "foo"`
 * - `requirements = ["foo==1.2.3", "bar>=1"]`
 * - `resolve = parametrize("py311", "py312")`
 */
const attribute = q
  .sym<Ctx>(attrNameRegex, (ctx, token) => startAttr(ctx, token.value))
  .op('=')
  .join(attributeValue);

const targetCall = q
  .sym<Ctx>(targetNameRegex, (ctx, token) => startTarget(ctx, token.value))
  .join(
    q.tree({
      type: 'wrapped-tree',
      maxDepth: 1,
      search: attribute,
      postHandler: endTarget,
    }),
  );

/**
 * `__defaults__(extend=True, all=dict(resolve="py311"))` and its `{...}` and
 * per-target-type spellings. Every `resolve=` in the call is read, at any
 * nesting depth, so `all=` and a per-type mapping look the same here.
 */
const resolveAssignment = q.alt<Ctx>(
  q
    .sym<Ctx>('resolve', (ctx) => startAttr(ctx, 'resolve'))
    .op('=')
    .join(q.alt<Ctx>(stringValue, parametrizeCall)),
  q
    .str<Ctx>('resolve', (ctx) => startAttr(ctx, 'resolve'))
    .op(':')
    .join(q.alt<Ctx>(stringValue, parametrizeCall)),
);

const scopedValueTree = q.tree<Ctx>({
  type: 'wrapped-tree',
  maxDepth: 3,
  search: resolveAssignment,
  postHandler: clearScope,
});

/**
 * A per-target-type mapping inside `__defaults__`, whose key is a target alias
 * or a tuple of them:
 *
 *     __defaults__({(poetry_requirements, python_requirement): dict(resolve="a")})
 *
 * The `resolve` values inside apply only to those types, which is what makes
 * them different from `all=`.
 */
const scopedDefaults = q
  .alt<Ctx>(
    q.tree({
      type: 'wrapped-tree',
      maxDepth: 1,
      startsWith: '(',
      endsWith: ')',
      search: q.many(q.sym<Ctx>((ctx, token) => addScope(ctx, token.value))),
    }),
    q.sym<Ctx>(targetNameRegex, (ctx, token) => addScope(ctx, token.value)),
    q.str<Ctx>(targetNameRegex, (ctx, token) => addScope(ctx, token.value)),
  )
  .op(':')
  .join(
    // The mapped value is written either as a `{...}` literal or as a
    // `dict(...)` call, which is a symbol followed by the same tree.
    q.alt<Ctx>(scopedValueTree, q.sym<Ctx>('dict').join(scopedValueTree)),
  );

const defaultsCall = q.sym<Ctx>('__defaults__', startDefaults).join(
  q.tree({
    type: 'wrapped-tree',
    maxDepth: 4,
    search: q.alt<Ctx>(
      q
        .sym<Ctx>('extend')
        .op('=')
        .sym((ctx, token) => setExtend(ctx, token.value)),
      scopedDefaults,
      resolveAssignment,
      // A call that sets no `resolve` still matters: without `extend=True` it
      // drops the defaults inherited from an ancestor build file. Matching any
      // symbol keeps such a call from failing the search, and so from being
      // discarded along with the context that recorded it.
      q.sym<Ctx>(null),
    ),
    postHandler: endDefaults,
  }),
);

const query = q.tree<Ctx>({
  type: 'root-tree',
  maxDepth: 16,
  search: q.alt<Ctx>(targetCall, defaultsCall),
});

export function parse(content: string): PantsParseResult {
  const res = python.query<Ctx, parser.Node>(content, query, {
    targets: [],
    defaults: [],
  });
  return { targets: res?.targets ?? [], defaults: res?.defaults ?? [] };
}
