# Portable Windows setup

The package entry point is `Setup.cmd` (Russian/English terminal wizard).
`Install-Mod.cmd` delegates to the same wizard. User instructions ship as
`README.ru.txt` and `README.en.txt`; both describe setup, authentication, updates,
rollback, recovery, legacy migration and the boundaries of connection checks.

## Inputs and authentication

Choose separate source, installation and Minecraft directories. The destination
must be empty for a first install. Updates require `installation.json` from this
wizard and keep the same game directory. Unmanaged older package folders are not
silently adopted. Fabric metadata must name the packaged Minecraft version,
the Fabric client entry point, and at least the required loader version. The user
selects that same profile in their launcher; setup does not install Java/Fabric or
rewrite launcher configuration. Game launch is always manual.

Local Git roots require a commit and checked-out branch. Setup registers them
without changing source, remotes or GitHub permissions. An optional `owner/repo`
enables GitHub reads through the user's `gh` authentication. Workspaces without
that setting expose local reads and reject `github_read` before invoking `gh`.

Agents can be omitted or created with their own provider/roles and disabled by
default. Capabilities use the same table as the game desk. Existing connections
are bound using the normal typed connection store; no credential fields are
accepted. A fresh profile is assembled separately and published by renaming the
complete profile only after all project/connection checks. Failed drafts remain
under `.installer-drafts` and never become the live profile.

Optional Claude workspace preparation writes neutral documents, explicit project
access and a generated session ID. `Start-Session.cmd` is an interactive command
the user runs themselves after signing in; setup does not run it or manufacture
native conversation history. Bind the workspace from the game after creating and
closing its native session. Provider-owned login directories and tokens are neither
read for copying nor bundled. Claude SDK developer authentication remains separately
configured by the operator.

Setup's connection check runs with the bridge stopped. It uses the adapters'
non-model diagnostics; Claude additionally verifies the native session belongs to
the workspace. It does not send a message, start work or modify the project.
Successful local authentication diagnostics do not establish API/model access.

## Update transaction

`release-manifest.json` hashes every shipped member after the privacy audit and
readiness marker. This detects corruption; it is not a publisher signature.
Reject unsafe paths, symlinks/junctions, overlapping roots and personal data in
the release manifest. A package update cannot replace its own running Node binary:
run Setup from a separate extracted release.

The transaction checks Windows processes and bridge owner PIDs, snapshots originals,
and records before/after hashes under `.installer-backups/<operation>`. It changes
only release-owned files, game JARs identified as `agentcraft`/`fabric-api`, a missing
client config, and any explicitly included schematic pack. Manually changed release
files block replacement; other mods remain. `data`, local workspaces, world saves,
personalities, memories, bindings, places and existing game settings are not reset.
`data` and AgentCraft game settings are additionally snapshotted; external provider
directories, local workspaces and complete worlds require their own backup.

An exclusive `.installer-active.json` prevents concurrent setup and bridge startup.
Recovery refuses a live installer PID. An interrupted preparation with no journal
can release its guard because destination writes have not started yet.
Profile configuration/checks use the same guard. Copy failures attempt to restore
original bytes. After interruption, Recover validates hashes before restoring; it
does not overwrite intervening edits. A dead profile-setup guard can be released
because profile publication is atomic and incomplete drafts are separate.

Rollback returns the previous release/mod files and retains current user data.
It is not automatic schema downgrading. If older binaries cannot read a newer
profile, stop and review the saved snapshot instead of silently discarding new
work. The first installation has no prior version. Rollback itself is journaled
and backed up, so an interruption uses the same recovery path.

## Verification

### Codex CLI command startup and task reports

The connection check confirms CLI capabilities and login; it does not execute
a project command or certify that the Windows sandbox can start. If a command
fails with `helper_unknown_error: setup refresh had errors`, AgentCraft reports
a sandbox startup error and leaves the task for an explicit retry on the board,
even when Codex ends its turn with exit code zero. Raw command output and local
paths are not copied into that diagnostic. Inspect `.codex/.sandbox` locally.
Keep the selected sandbox policy while investigating; do not use full access
as a substitute for repairing setup. See the
[official Windows sandbox troubleshooting](https://learn.chatgpt.com/docs/windows/windows-sandbox).

A malformed final report for the current run produces a specific rejection on
the board without accepting the result or advancing review. `ci` accepts only
`pass`, `fail`, or `unknown`; use `unknown` when checks did not run. Reports from
an old run, another agent, a paused run, or a replaced connection cannot use this
diagnostic path to interrupt the current task.

`tools/test/portable-install.test.mjs` exercises install/update/rollback, exact data
preservation, renamed mods, Fabric versions, paths, process/owner refusals, checksums,
links, copy failure and interrupted recovery in disposable directories.
`foreman/test/setup-package.test.ts` covers fresh/empty/three-agent profiles, role
validation, staged failure, local-only project access and no Git mutation.
The packaged setup is also loaded from its bundled entry point, alongside the
portable studio/migration checks. These tests do not claim an interactive manual
wizard run, live Minecraft UI verification or model/account authorization tests.

The scenario matrix, clean installed-bridge trial and remaining acceptance work
are recorded in [PORTABLE_TRIAL.md](PORTABLE_TRIAL.md). Passing automated setup
checks alone is not a public-release acceptance decision.
