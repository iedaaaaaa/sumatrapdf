# SumatraPDF Explorer-style tabs custom build

This public fork carries a small Windows 11 Explorer-inspired tab and window-frame customization on top of the upstream SumatraPDF `master` commit `a22bb169e0da99b93fae4f2529de22e62ce0aeef`.

## Upstream and build

- Upstream: https://github.com/sumatrapdfreader/sumatrapdf
- Base commit: `a22bb169e0da99b93fae4f2529de22e62ce0aeef`
- Workflow: `Build Custom SumatraPDF`
- Trigger: manual `workflow_dispatch` only
- Runner: `windows-2025-vs2026`
- Command: `bun .\cmd\build.ts -release -clean`

The build is performed only by GitHub-hosted Actions. It does not use the upstream CI publishing mode, release secrets, R2/Backblaze publishing, or code signing.

## UI changes

- Default tabs use the tab-strip color for inactive tabs, a subtle hover accent, and a stronger selected-tab accent.
- The toolbar uses the same selected default-tab surface color.
- Every closable tab keeps its close button visible while retaining the existing hit area and hover behavior.
- User-selected tab colors retain their existing selected and shaded inactive/hover behavior.
- A low-contrast, DPI-scaled separator is drawn only between visually adjacent inactive tabs, including correct RTL ordering.
- The drag image uses the same selected-tab background calculation as normal painting.
- Custom dark themes use a restrained active DWM frame border and a background-colored inactive border. Native DWM shadow and window geometry remain OS-managed.

Existing close-button, dirty-indicator, page-number, error-text, tab-drag, reorder, and migration behavior is retained.

## Artifact contents

Each manual run uploads a three-day artifact containing only:

- `SumatraPDF.exe`
- `SHA256SUMS.txt`
- `BUILD-INFO.txt`
- `PATCH.txt`

The executable is an unsigned custom build. Download the artifact from the Actions run, extract it to a separate test directory, and run it side-by-side with the installed SumatraPDF. Do not replace the installed executable or change file associations.

This fork should be rebased or otherwise updated when upstream changes the relevant source or build scripts.
