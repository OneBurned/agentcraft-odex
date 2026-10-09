# Preparing the Windows prerelease

## Published candidate

[AgentCraft 0.4.13-rc.1](https://github.com/OneBurned/agentcraft-odex/releases/tag/v0.4.13-rc.1)
was published on 2026-10-09 at 01:34:24 UTC after the user's final confirmation.
It is a prerelease. Its tag and `codex/portable-0.4.13-rc.1` branch point to public
snapshot `7bffdcdf52a8a7fa5258c1c125217cd4681988ad`.

All seven uploaded assets were downloaded again and their SHA-256 hashes matched
the prepared files. The ZIP SHA-256 is
`75ae6fe93e1df248033063a49ba86ce9bbbb08380cb6243a155706ed4fcdbef8`.
The attached `CHECKS.json` records preparation-time state (`published: false`);
it is retained unchanged with the verified assets. Publication does not complete
the outstanding Claude planner and manual/live acceptance work in t52/t53.

## Preparing another candidate

The current candidate is **0.4.13-rc.1**, mod 0.4.13, protocol 2. It must be marked
as a GitHub **prerelease**, not latest/stable. [PORTABLE_TRIAL.md](PORTABLE_TRIAL.md)
records pending Claude planning and manual/live acceptance (t52/t53). Preparing a
candidate does not close those items. The final publication question must include
these limitations and the exact tag/assets; no push or release creation precedes
the user's explicit answer.

Build with `node tools/build-portable.mjs <new folder> --public`. This removes the
six user-supplied PNGs and labels, compiles the bridge without those preset choices,
and rejects private schematics. Original class/dependency bytes and custom PNG
import are preserved. `--public` is required even when building from the public
source snapshot, where the six files are absent. Update all mod/bridge/tools together.

Run public-package, portable-trial, studio-package, setup-package and migration-package
checks on that folder, plus the packaged Java PNG importer. Keep actual test results
and unverified live checks separate. Use `tools/prepare-release.mjs` to produce a
fresh asset folder with a ZIP, SHA256SUMS, RU/EN notes, notices, AUDIT and CHECKS:

```text
node tools/prepare-release.mjs <public package> <new asset folder> 0.4.13-rc.1 <checks.json>
```

The helper verifies the package manifest, round-trips every ZIP member, then audits
the extracted archive. It never invokes GitHub, pushes, creates a release or overwrites
an existing output folder. Checks are supplied from the actual run, not inferred
from the presence of a build artifact. Checksum files cover every other asset.

## Source publication

Do not push the private development branch: its history contains the six PNGs and
personal presets. Prepare a separate local `codex/portable-0.4.13-rc.1` snapshot
with the public upstream main commit as its parent. Use a separate Git index;
do not switch, reset or rewrite the working branch. Exclude the six image files,
replace personal cast/persona/workspace templates with the portable neutral templates,
replace local-machine setup documentation/README with public setup pointers, and use
neutral world defaults. Preserve original licenses. The private branch stays local.

Verify that none of the six image blobs is reachable through the prospective public
branch and that its only new history is the prepared snapshot. Inspect the source tree
and its diff before asking permission. The source snapshot and release assets are
distinct artifacts; the package leak scanner validates the distributable package,
not all source tests (which deliberately contain leak-detection fixtures).

After explicit final confirmation, push only this verified release branch and its
tag, then create the prerelease in the requested repository with the exact prepared
assets. Never push the private development branch or use a wildcard refspec. If the
assets, target tree or release classification change, prepare and review the updated
proposal before publication. Confirm the GitHub release URL and uploaded asset
checksums after publishing. Until then the task requires a question report, not done.

## Licenses

Package notices include AgentCraft MIT, Fabric API Apache-2.0, Node and its bundled
notices, ws/zod/MCP SDK MIT, and the unmodified Claude Agent SDK proprietary notice.
Java-WebSocket notices remain in its nested JAR; bundled JS legal-comment files stay
present. Minecraft/Java/Fabric Loader and user provider applications/accounts are not
redistributed. See the release notes and THIRD_PARTY_NOTICES.txt for provider terms.
