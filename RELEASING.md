# Releasing hostmon

Releases use GitHub Actions and PyPI Trusted Publishing; no API token is stored
in GitHub.

## One-time PyPI setup

Because `hostmon` is a new project, add a pending trusted publisher at
<https://pypi.org/manage/account/publishing/>:

- PyPI project name: `hostmon`
- GitHub owner: `HSPK`
- GitHub repository: `hostmon`
- Workflow filename: `publish.yml`
- Environment name: `pypi`

The matching GitHub `pypi` environment is already declared by the workflow.

## Publish a version

1. Update `project.version` in `pyproject.toml` and `__version__` in
   `src/host_monitor/__init__.py`.
2. Add the release notes to `CHANGELOG.md`.
3. Run:

   ```bash
   python -m unittest discover -s tests -v
   rm -rf build dist
   python -m build
   python -m twine check dist/*
   ```

4. Commit and push the changes.
5. Create a GitHub release whose tag exactly matches `v<project.version>`, for
   example `v0.1.0`.

Publishing the release runs tests, verifies that the tag and package versions
match, builds the wheel and sdist, and publishes them to PyPI with OIDC.
