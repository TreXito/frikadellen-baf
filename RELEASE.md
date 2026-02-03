# Release Process

This document explains how to create a new release of FrikadellenBAF.

## Issue with Release 1.0

The release `1.0` was created but has no executable assets attached. This happened because:

1. The tag `1.0` was created without the `v` prefix
2. The GitHub Actions workflow was configured to only trigger on tags matching `v*`
3. Since the tag pattern didn't match, the workflow never ran
4. As a result, no executables were built or uploaded to the release

This issue has been fixed by updating the workflow to accept tags both with and without the `v` prefix.

## Creating a New Release

To create a new release with pre-built executables, follow these steps:

### 1. Update the Version

Update the version in `package.json`:

```json
{
  "name": "baf",
  "version": "2.0.1",
  ...
}
```

### 2. Commit Your Changes

```bash
git add package.json
git commit -m "Bump version to 2.0.1"
git push origin main
```

### 3. Create and Push a Tag

Create a tag that matches the version in `package.json`. You can use either format:

**With `v` prefix (recommended):**
```bash
git tag v2.0.1
git push origin v2.0.1
```

**Without `v` prefix:**
```bash
git tag 2.0.1
git push origin 2.0.1
```

### 4. Wait for the Workflow

The GitHub Actions workflow will automatically:

1. Checkout the code
2. Install dependencies
3. Build the TypeScript code
4. Build executables for:
   - Windows (win-x64)
   - Linux (linux-x64)
   - macOS (macos-x64)
5. Create a GitHub release with the tag name
6. Upload all executables and start scripts to the release

You can monitor the workflow progress at:
https://github.com/TreXito/frikadellen-baf/actions

### 5. Verify the Release

Once the workflow completes:

1. Go to https://github.com/TreXito/frikadellen-baf/releases
2. Find your new release
3. Verify that the following files are attached:
   - `BAF-v2.0.1-win.exe` (or without `v` if you used that format)
   - `BAF-v2.0.1-linux`
   - `BAF-v2.0.1-macos`
   - `BAF.ps1`
   - `BAF.cmd`

## Supported Tag Formats

The workflow will trigger on any of these tag patterns:

- `v*` - Any tag starting with `v` (e.g., `v1.0`, `v2.0.1`, `v2.0.1-beta`)
- `[0-9]*` - Any tag starting with a digit (e.g., `2.0.1`, `1.0`)

This covers all common version tag formats used in semantic versioning.

## Recommended Tag Format

For consistency, it's recommended to use the `v` prefix format (e.g., `v2.0.1`) to match standard semantic versioning conventions used by most projects.

## Fixing the Existing Release 1.0

The existing release `1.0` can be fixed by:

1. Creating a new tag `v2.0.1` (which matches the current package.json version)
2. Letting the workflow build and attach the executables
3. Optionally deleting the old `1.0` tag and release if no longer needed

Or alternatively, you could:

1. Manually trigger the workflow using the "workflow_dispatch" option
2. Manually build and upload the executables to the existing release

However, creating a new properly-tagged release is the recommended approach.
