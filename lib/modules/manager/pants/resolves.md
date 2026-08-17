# Prototype: recording Pants resolves

Not part of [renovatebot/renovate#45321](https://github.com/renovatebot/renovate/pull/45321).
This branch adds metadata only: extraction annotates each dependency with the
Pants resolves it belongs to, and no behaviour changes. It exists to show what
`updateArtifacts` would have to work with if the manager ever regenerated
Pants lockfiles.

## What it records

Each dependency gets `managerData`:

```json
{
  "resolves": ["py311", "data-science"],
  "resolveSource": "field",
  "lockFiles": [
    "3rdparty/python/py311.lock",
    "3rdparty/python/data-science.lock"
  ]
}
```

`resolveSource` says where the answer came from — the target's own `resolve`
field, an inherited `__defaults__`, or `[python] default_resolve` — which is
what makes a wrong annotation debuggable.

`lockFiles` is also set on the package file, but only as the union across the
file: `lockFiles` is a package-file-level field in Renovate's types, while
`managerData` is per dependency and is handed to `updateArtifacts` on every
updated dependency. The per-dependency copy is therefore the one an
`updateArtifacts` implementation should use to build
`pants generate-lockfiles --resolve=…` arguments.

Nothing is annotated unless `pants.toml` sets `[python] enable_resolves`.

## How a resolve is inferred

In precedence order:

1. The target's `resolve` field, including `resolve=parametrize("a", "b")`,
   which puts one requirement in several resolves. A generator's `resolve` is a
   Pants _moved field_, so it applies to every requirement it generates.
2. The `__defaults__` in effect for the build file's directory. Pants inherits
   these from the nearest ancestor build file, and a call without
   `extend=True` replaces the inherited defaults instead of merging with them —
   so a `__defaults__` that sets no `resolve` can still drop one an ancestor
   set. Per-target-type mappings are scoped to those types and beat `all=`.
3. `[python] default_resolve`, itself defaulting to `python-default`.

Resolve names are mapped to lockfile paths through `[python.resolves]`.

## Verified against `pants peek`

`pants peek` is the authoritative answer, since Pants itself applies the
defaults and expands `parametrize`. Compared over ten directories of a private
Pants monorepo (2,577 build files, 25 resolves), grouping by directory and
requirement name:

| directories                                                | requirements | agreed | mismatched |
| ---------------------------------------------------------- | ------------ | ------ | ---------- |
| explicit fields, `parametrize`, `default_resolve` fallback | 370          | 369    | 0          |
| `__defaults__` inheritance, per-type mappings              | 208          | 208    | 0          |

The one requirement not agreed on is invisible to extraction rather than
mis-annotated: `en_core_web_sm @ https://…whl`, a direct URL requirement that
the `pip_requirements` line parser drops. Requirements that Renovate extracts
but Pants does not turn into targets — Poetry `path` dependencies, which are
marked `path-dependency` and skipped, and `[build-system] requires` — were
excluded from the comparison.

## Known limits of static inference

- Only `pants.toml` is read. Pants layers `pants.<name>.toml` files, `PANTS_*`
  environment variables and command line flags over it, and interpolates
  `%(placeholder)s` values.
- `parametrize` group names are ignored, and only positional arguments of
  `resolve=parametrize(...)` are read as resolve names.
- A generator's `overrides={"dist": {"resolve": …}}` is not read, so a
  per-requirement resolve override inside a generator is missed.
- Computed values — a `resolve` built from a variable, a macro, or a
  `.pants.d` plugin — cannot be seen at all.

Each of these is a case where `pants peek --output=json` would simply be
correct, at the cost of running Pants during extraction. A plausible shape is
to keep static inference as the default and make peek opt-in
(`pants: { usePantsPeek: true }`) for repositories whose build files defeat it,
with `resolveSource` in the manager data telling the two apart in logs.
