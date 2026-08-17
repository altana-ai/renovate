import { codeBlock } from 'common-tags';
import { fs } from '../../../../test/util.ts';
import { extractAllPackageFiles, extractPackageFile } from './index.ts';

vi.mock('../../../util/fs/index.ts');

const buildFile = codeBlock`
  python_requirement(
      name="pytest-mock",
      requirements=["pytest-mock>=3.12,<4"],
      resolve=parametrize("py311"),
  )

  # A comment between targets, and a pin with a reason.
  python_requirement(
      name="pinned",
      requirements=[
          "fancycompleter<=0.10.0",
          "requests[security]==2.31.0",
      ],
  )

  python_requirement(
      name="no-version",
      requirements=["types-protobuf"],
  )

  python_requirements(
      name="app",
      source="app-requirements.txt",
      resolve="app",
      module_mapping={
          "fpdf2": ["fpdf"],
          "pillow": ["PIL"],
      },
      overrides={
          "fastapi": {
              "dependencies": [
                  ":app#orjson",
              ],
          },
      },
  )

  python_requirements(
      name="default-source",
  )

  python_sources(
      name="lib",
  )
`;

function mockFiles(files: Record<string, string>): void {
  fs.getSiblingFileName.mockImplementation(
    (existingFileNameWithPath: string, otherFileName: string) =>
      existingFileNameWithPath
        .slice(0, existingFileNameWithPath.lastIndexOf('/') + 1)
        .concat(otherFileName),
  );
  fs.readLocalFile.mockImplementation(
    (fileName: string): Promise<any> => Promise.resolve(files[fileName]),
  );
}

describe('modules/manager/pants/extract', () => {
  describe('extractPackageFile()', () => {
    it('returns null for a build file without requirements', async () => {
      const content = codeBlock`
        python_sources(name="lib")
        python_requirements(name="reqs", source="requirements.txt")
      `;
      expect(await extractPackageFile(content, 'BUILD.pants')).toBeNull();
    });

    it('returns null for unparseable content', async () => {
      expect(
        await extractPackageFile('!!! not python', 'BUILD.pants'),
      ).toBeNull();
    });

    it('extracts python_requirement targets', async () => {
      const res = await extractPackageFile(buildFile, 'BUILD.pants');
      expect(res).toEqual({
        deps: [
          {
            datasource: 'pypi',
            depName: 'pytest-mock',
            packageName: 'pytest-mock',
            currentValue: '>=3.12,<4',
            depType: 'python_requirement',
            replaceString: 'pytest-mock>=3.12,<4',
          },
          {
            datasource: 'pypi',
            depName: 'fancycompleter',
            packageName: 'fancycompleter',
            currentValue: '<=0.10.0',
            depType: 'python_requirement',
            replaceString: 'fancycompleter<=0.10.0',
          },
          {
            datasource: 'pypi',
            depName: 'requests',
            packageName: 'requests',
            currentValue: '==2.31.0',
            currentVersion: '2.31.0',
            depType: 'python_requirement',
            replaceString: 'requests[security]==2.31.0',
          },
          {
            datasource: 'pypi',
            depName: 'types-protobuf',
            packageName: 'types-protobuf',
            currentValue: undefined,
            depType: 'python_requirement',
            replaceString: 'types-protobuf',
          },
        ],
      });
    });

    it('handles the plain BUILD file name', async () => {
      const content = codeBlock`
        python_requirement(requirements=["click==8.1.7"])
      `;
      expect((await extractPackageFile(content, 'BUILD'))?.deps).toMatchObject([
        { depName: 'click', depType: 'python_requirement' },
      ]);
    });

    it('ignores strings outside the supported fields', async () => {
      const content = codeBlock`
        python_requirements(
            name="reqs",
            source="reqs.txt",
            module_mapping={"pillow": ["PIL"]},
            overrides={"fastapi": {"dependencies": ["orjson==3.9.0"]}},
        )
      `;
      expect(await extractPackageFile(content, 'BUILD.pants')).toBeNull();
    });

    it('skips requirements it cannot parse', async () => {
      const content = codeBlock`
        python_requirement(
            requirements=["==1.2.3", "click==8.1.7"],
        )
      `;
      expect(
        (await extractPackageFile(content, 'BUILD.pants'))?.deps,
      ).toMatchObject([{ depName: 'click' }]);
    });

    it('extracts VCS requirements', async () => {
      const content = codeBlock`
        python_requirement(
            requirements=["some-package @ git+https://github.com/foo/bar@v1.2.3"],
        )
      `;
      expect((await extractPackageFile(content, 'BUILD.pants'))?.deps).toEqual([
        {
          datasource: 'git-tags',
          depName: 'bar',
          packageName: 'https://github.com/foo/bar',
          currentValue: 'v1.2.3',
          currentVersion: 'v1.2.3',
          depType: 'python_requirement',
          replaceString: 'some-package @ git+https://github.com/foo/bar@v1.2.3',
        },
      ]);
    });

    it('parses a Poetry pyproject.toml source', async () => {
      const content = codeBlock`
        [tool.poetry]
        name = "my-package"

        [tool.poetry.dependencies]
        python = "^3.11"
        requests = "^2.31.0"

        [tool.poetry.group.dev.dependencies]
        pytest = "^8.0.0"
      `;
      const res = await extractPackageFile(content, 'pyproject.toml');
      expect(res?.deps).toMatchObject([
        { depName: 'python', currentValue: '^3.11' },
        { depName: 'requests', currentValue: '^2.31.0' },
        { depName: 'pytest', currentValue: '^8.0.0', depType: 'dev' },
      ]);
    });

    it('parses a pyproject.toml source as PEP 621', async () => {
      const content = codeBlock`
        [project]
        name = "my-package"
        dependencies = ["typing-extensions>=4.8.0,<5.0.0"]
      `;
      const res = await extractPackageFile(content, 'pyproject.toml');
      expect(res?.deps).toMatchObject([
        { depName: 'typing-extensions', currentValue: '>=4.8.0,<5.0.0' },
      ]);
    });

    it('parses a requirements file as such', async () => {
      const res = await extractPackageFile(
        'click==8.1.7\n',
        'requirements.txt',
      );
      expect(res?.deps).toMatchObject([
        { depName: 'click', currentValue: '==8.1.7' },
      ]);
    });
  });

  describe('extractAllPackageFiles()', () => {
    it('returns build file deps and the referenced source files', async () => {
      mockFiles({
        'BUILD.pants': buildFile,
        'app-requirements.txt': 'fastapi==0.110.0\norjson>=3\n',
        'requirements.txt': 'click==8.1.7\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res).toMatchObject([
        {
          packageFile: 'BUILD.pants',
          deps: [
            { depName: 'pytest-mock' },
            { depName: 'fancycompleter' },
            { depName: 'requests' },
            { depName: 'types-protobuf' },
          ],
        },
        {
          packageFile: 'app-requirements.txt',
          deps: [
            { depName: 'fastapi', depType: 'python_requirements' },
            { depName: 'orjson', depType: 'python_requirements' },
          ],
        },
        {
          packageFile: 'requirements.txt',
          deps: [{ depName: 'click', depType: 'python_requirements' }],
        },
      ]);
    });

    it('extracts a pyproject.toml source', async () => {
      mockFiles({
        'pkg/BUILD.pants':
          'python_requirements(name="reqs", source="pyproject.toml")\n',
        'pkg/pyproject.toml': codeBlock`
          [project]
          name = "my-package"
          requires-python = ">=3.12,<3.13"
          dependencies = ["typing-extensions>=4.8.0,<5.0.0"]
        `,
      });

      const res = await extractAllPackageFiles({}, ['pkg/BUILD.pants']);
      expect(res).toMatchObject([
        {
          packageFile: 'pkg/pyproject.toml',
          deps: [
            { packageName: 'python', currentValue: '>=3.12,<3.13' },
            {
              depName: 'typing-extensions',
              depType: 'project.dependencies',
            },
          ],
        },
      ]);
    });

    it('extracts a poetry_requirements source', async () => {
      mockFiles({
        'pkg/BUILD.pants': codeBlock`
          poetry_requirements(
              name="reqs",
              module_mapping={"pillow": ["PIL"]},
          )
        `,
        'pkg/pyproject.toml': codeBlock`
          [tool.poetry]
          name = "my-package"

          [tool.poetry.dependencies]
          requests = "^2.31.0"

          [tool.poetry.group.dev.dependencies]
          pytest = "^8.0.0"
        `,
      });

      const res = await extractAllPackageFiles({}, ['pkg/BUILD.pants']);
      expect(res).toMatchObject([
        {
          packageFile: 'pkg/pyproject.toml',
          deps: [
            { depName: 'requests', depType: 'dependencies' },
            { depName: 'pytest', depType: 'dev' },
          ],
        },
      ]);
    });

    it('extracts a poetry_requirements source from another directory', async () => {
      mockFiles({
        'BUILD.pants':
          'poetry_requirements(name="reqs", source="subdir/pyproject.toml")\n',
        'subdir/pyproject.toml': codeBlock`
          [tool.poetry.dependencies]
          requests = "^2.31.0"
        `,
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res).toMatchObject([
        {
          packageFile: 'subdir/pyproject.toml',
          deps: [{ depName: 'requests' }],
        },
      ]);
    });

    it('extracts a uv_requirements source', async () => {
      mockFiles({
        'pkg/BUILD.pants': 'uv_requirements(name="reqs")\n',
        'pkg/pyproject.toml': codeBlock`
          [project]
          name = "my-package"
          dependencies = ["requests>=2.31.0"]

          [tool.uv]
          dev-dependencies = ["pytest>=8.0.0"]
        `,
      });

      const res = await extractAllPackageFiles({}, ['pkg/BUILD.pants']);
      expect(res).toMatchObject([
        {
          packageFile: 'pkg/pyproject.toml',
          deps: [
            { depName: 'requests', depType: 'project.dependencies' },
            { depName: 'pytest', depType: 'tool.uv.dev-dependencies' },
          ],
        },
      ]);
    });

    it('extracts a shared source file once', async () => {
      mockFiles({
        'BUILD.pants': 'python_requirements(name="reqs")\n',
        'requirements.txt': 'click==8.1.7\n',
      });

      const res = await extractAllPackageFiles({}, [
        'BUILD.pants',
        'BUILD.pants',
      ]);
      expect(
        res.filter((f) => f.packageFile === 'requirements.txt'),
      ).toHaveLength(1);
    });

    it('skips missing build files', async () => {
      mockFiles({});
      expect(await extractAllPackageFiles({}, ['missing/BUILD.pants'])).toEqual(
        [],
      );
    });

    it('skips a source file with no deps', async () => {
      mockFiles({
        'BUILD.pants': 'python_requirements(name="reqs")\n',
        'requirements.txt': '# nothing here\n',
      });
      expect(await extractAllPackageFiles({}, ['BUILD.pants'])).toEqual([]);
    });

    it('skips a missing python_requirements source', async () => {
      mockFiles({
        'BUILD.pants': 'python_requirements(name="reqs", source="nope.txt")\n',
      });
      expect(await extractAllPackageFiles({}, ['BUILD.pants'])).toEqual([]);
    });
  });
  describe('resolves', () => {
    const pantsToml = codeBlock`
      [python]
      enable_resolves = true
      default_resolve = "py311"

      [python.resolves]
      py311 = "3rdparty/python/py311.lock"
      py312 = "3rdparty/python/py312.lock"
      data-science = "3rdparty/python/data-science.lock"
    `;

    it('reads the resolve from the target field', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          python_requirement(
              name="click",
              requirements=["click==8.1.7"],
              resolve="data-science",
          )
        `,
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0]).toMatchObject({
        lockFiles: ['3rdparty/python/data-science.lock'],
        deps: [
          {
            depName: 'click',
            managerData: {
              resolves: ['data-science'],
              resolveSource: 'field',
              lockFiles: ['3rdparty/python/data-science.lock'],
            },
          },
        ],
      });
    });

    it('reads every resolve of a parametrized field', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          python_requirement(
              name="click",
              requirements=["click==8.1.7"],
              resolve=parametrize("py311", "py312"),
          )
        `,
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        managerData: {
          resolves: ['py311', 'py312'],
          resolveSource: 'field',
          lockFiles: [
            '3rdparty/python/py311.lock',
            '3rdparty/python/py312.lock',
          ],
        },
      });
    });

    it('falls back to default_resolve', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': 'python_requirement(requirements=["click==8.1.7"])\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        managerData: {
          resolves: ['py311'],
          resolveSource: 'default_resolve',
          lockFiles: ['3rdparty/python/py311.lock'],
        },
      });
    });

    it('applies __defaults__ from the same build file', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          __defaults__(extend=True, all=dict(resolve="py312"))

          python_requirement(requirements=["click==8.1.7"])
        `,
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        managerData: {
          resolves: ['py312'],
          resolveSource: 'defaults',
          lockFiles: ['3rdparty/python/py312.lock'],
        },
      });
    });

    it('inherits __defaults__ from the nearest ancestor build file', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'apps/BUILD.pants': '__defaults__(all=dict(resolve="py312"))\n',
        'apps/svc/pkg/BUILD.pants':
          'python_requirement(requirements=["click==8.1.7"])\n',
      });

      const res = await extractAllPackageFiles({}, [
        'apps/BUILD.pants',
        'apps/svc/pkg/BUILD.pants',
      ]);
      expect(res[0].deps[0]).toMatchObject({
        managerData: { resolves: ['py312'], resolveSource: 'defaults' },
      });
    });

    it('prefers the nearest ancestor defaults', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'apps/BUILD.pants': '__defaults__(all=dict(resolve="py312"))\n',
        'apps/svc/BUILD.pants':
          '__defaults__(all=dict(resolve="data-science"))\n',
        'apps/svc/pkg/BUILD.pants':
          'python_requirement(requirements=["click==8.1.7"])\n',
      });

      const res = await extractAllPackageFiles({}, [
        'apps/BUILD.pants',
        'apps/svc/BUILD.pants',
        'apps/svc/pkg/BUILD.pants',
      ]);
      const dep = res.find((f) => f.packageFile === 'apps/svc/pkg/BUILD.pants')!
        .deps[0];
      expect(dep).toMatchObject({
        managerData: { resolves: ['data-science'] },
      });
    });

    it('drops inherited defaults when a call does not extend', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'apps/BUILD.pants': '__defaults__(all=dict(resolve="py312"))\n',
        'apps/svc/BUILD.pants': codeBlock`
          __defaults__(all=dict(skip_mypy=True))

          python_requirement(requirements=["click==8.1.7"])
        `,
      });

      const res = await extractAllPackageFiles({}, [
        'apps/BUILD.pants',
        'apps/svc/BUILD.pants',
      ]);
      expect(res[0].deps[0]).toMatchObject({
        managerData: { resolves: ['py311'], resolveSource: 'default_resolve' },
      });
    });

    it('scopes a per-target-type __defaults__ mapping to those types', async () => {
      // A shape seen in the wild: source targets are parametrized over two
      // resolves while the requirement generator is pinned to one.
      mockFiles({
        'pants.toml': pantsToml,
        'pkg/BUILD.pants': codeBlock`
          __defaults__(
              {
                  (python_sources, python_tests): dict(
                      **parametrize("py311", resolve="py311"),
                      **parametrize("py312", resolve="py312"),
                  ),
                  (poetry_requirements): dict(
                      **parametrize("py311", resolve="py311"),
                  ),
              },
              all=dict(skip_mypy=False),
              extend=True,
          )

          poetry_requirements(name="poetry")
        `,
        'pkg/pyproject.toml': codeBlock`
          [tool.poetry.dependencies]
          requests = "^2.31.0"
        `,
      });

      const res = await extractAllPackageFiles({}, ['pkg/BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        depName: 'requests',
        managerData: { resolves: ['py311'], resolveSource: 'defaults' },
      });
    });

    it('annotates a generator source with the generator resolve', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          python_requirements(
              name="reqs",
              resolve=parametrize("py311", "py312"),
          )
        `,
        'requirements.txt': 'click==8.1.7\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0]).toMatchObject({
        packageFile: 'requirements.txt',
        lockFiles: ['3rdparty/python/py311.lock', '3rdparty/python/py312.lock'],
        deps: [
          {
            depName: 'click',
            managerData: { resolves: ['py311', 'py312'] },
          },
        ],
      });
    });

    it('unions the resolves of two targets sharing one source', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          python_requirements(name="a", resolve="py311")
          python_requirements(name="b", resolve="py312")
        `,
        'requirements.txt': 'click==8.1.7\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res).toHaveLength(1);
      expect(res[0]).toMatchObject({
        packageFile: 'requirements.txt',
        lockFiles: ['3rdparty/python/py311.lock', '3rdparty/python/py312.lock'],
        deps: [
          {
            depName: 'click',
            managerData: { resolves: ['py311', 'py312'] },
          },
        ],
      });
    });

    it('does not union resolves when they are not enabled', async () => {
      mockFiles({
        'pants.toml': '[python]\nenable_resolves = false\n',
        'BUILD.pants': codeBlock`
          python_requirements(name="a", resolve="py311")
          python_requirements(name="b", resolve="py312")
        `,
        'requirements.txt': 'click==8.1.7\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res).toHaveLength(1);
      expect(res[0].deps[0].managerData).toBeUndefined();
    });

    it('reads a string-keyed __defaults__ mapping', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          __defaults__({"python_requirement": {"resolve": "py312"}})

          python_requirement(requirements=["click==8.1.7"])
        `,
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        managerData: { resolves: ['py312'], resolveSource: 'defaults' },
      });
    });

    it('reads a symbol-keyed __defaults__ mapping', async () => {
      mockFiles({
        'pants.toml': pantsToml,
        'BUILD.pants': codeBlock`
          __defaults__({python_requirement: dict(resolve="data-science")})

          python_requirement(requirements=["click==8.1.7"])
        `,
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        managerData: { resolves: ['data-science'], resolveSource: 'defaults' },
      });
    });

    it('annotates nothing when resolves are not enabled', async () => {
      mockFiles({
        'pants.toml': '[python]\nenable_resolves = false\n',
        'BUILD.pants':
          'python_requirement(requirements=["click==8.1.7"], resolve="py311")\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0].managerData).toBeUndefined();
      expect(res[0].lockFiles).toBeUndefined();
    });

    it('annotates resolves without a lockfile path', async () => {
      mockFiles({
        'pants.toml': '[python]\nenable_resolves = true\n',
        'BUILD.pants':
          'python_requirement(requirements=["click==8.1.7"], resolve="mystery")\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0]).toMatchObject({
        managerData: { resolves: ['mystery'], lockFiles: [] },
      });
      expect(res[0].lockFiles).toBeUndefined();
    });

    it('ignores an unparseable pants.toml', async () => {
      mockFiles({
        'pants.toml': 'this is not toml [[[',
        'BUILD.pants': 'python_requirement(requirements=["click==8.1.7"])\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0].managerData).toBeUndefined();
    });

    it('skips annotation without a pants.toml', async () => {
      mockFiles({
        'BUILD.pants': 'python_requirement(requirements=["click==8.1.7"])\n',
      });

      const res = await extractAllPackageFiles({}, ['BUILD.pants']);
      expect(res[0].deps[0].managerData).toBeUndefined();
    });
  });
});
