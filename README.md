# AgentCraft portable for Windows

Multiple Codex and Claude agents in Minecraft with separate sessions and configurable roles.

This branch is the public source snapshot for 0.4.13-rc.1, not a stable release.
Read [release notes](docs/releases/0.4.13-rc.1.en.md) or [заметки RU](docs/releases/0.4.13-rc.1.ru.md).

Install the release ZIP using Setup.cmd. Requirements and limitations: [portable setup](docs/PORTABLE_SETUP.md), [acceptance report](docs/PORTABLE_TRIAL.md).

Build sources with Node 24, JDK 25, npm ci in foreman and tools, then mod/gradlew.bat build using repository .gradle-home. Run node tools/build-portable.mjs <new-folder> --public. Private skin resources are intentionally absent.

Original AgentCraft: MIT; dependencies retain their own terms. See LICENSE and tools/portable/THIRD_PARTY_NOTICES.txt.
