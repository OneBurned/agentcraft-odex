AgentCraft — portable Windows package

A3 — PER-AGENT CONNECTIONS
A new profile creates an empty team.json. Manage agents with studio.mjs actions
team.get/create/update/disable/archive/restore. Each agent has its own connection through
connection.bind/get/check/send/control/unbind/importCodex. Two agents of one provider need distinct
conversations. The role queue and setup UI are subsequent stages. Protocol 2 requires matching
mod, bridge and tools. Legacy migration is a separate stage.

This is a neutral build of the existing observer mode: Codex performs work in a
connected desktop conversation or its own CLI session; Claude can review changes. Arbitrary teams are configured
through the API; the graphical setup wizard is not ready. No account logins are included.

INSTALL AND START
1. Install Minecraft Java 26.3, Fabric Loader 0.19.5 or newer, and Java 25.
   You need Git and your own signed-in Codex desktop application or native Codex CLI.
   Reviews require your own installed and signed-in Claude Code.
2. Extract the complete package to a separate folder. Check PACKAGE-READY.json exists.
   Do not put the package inside mods. Save your world and close Minecraft first.
3. Run Install-Mod.cmd and select your Fabric profile's game directory.
   AgentCraft and Fabric API are installed; replaced mods are backed up.
   Existing settings are preserved. Minecraft is not launched automatically.
4. Run Start-Bridge.cmd. To select a Git repository, run this instead from PowerShell
   in the package folder:
   .\Start-Bridge.ps1 -Repository <full-path-to-your-repository>
   The bridge listens on 127.0.0.1:7878 only. Stop another bridge if the port is busy.
5. Create an agent using runtime/node.exe studio.mjs team.create --file agent.json.
   Payload: revision from team.get and agent with name, provider (codex/claude),
   roles (array of planner/developer/reviewer), enabled, visible and appearance
   (skin, #RRGGBB color, slim). All fields are required.
   Get its ID using runtime/node.exe studio.mjs team.get.
   In the chosen authorized desktop chat run Connect-Codex.ps1 -Agent <id>.
   Bindings live in data/portable/connections. Double-click cannot supply the chat identity.
   Claude requires a separately configured workspace with instructions, MEMORY.md,
   access.json and conversation.json naming an existing native session created in that cwd.
   connection.bind payload: id, revision, connection: {provider:"claude",
   transport:"claude-code",workspace:"absolute path",sessionId:"UUID"}.
   Send with runtime/node.exe studio.mjs connection.bind --file binding.json.
   Open-Agent.ps1 -Agent <id> continues that conversation in the terminal; -Desktop
   hands off to Code, -Return returns after closing its Code session. No duplicate session.
   Legacy profiles without team.json can still run Connect-Codex.ps1 without -Agent;
   that updates data/portable/codex-chat.json. Team profiles require -Agent.
   One damaged connection does not disable other agents. Detach an inactive damaged
   binding with connection.unbind (id and revision), including an archived entry.
6. Start your Fabric profile and open an ordinary single-player world.
   Find the command desk, console, monitor and workspace configurator in the creative
   inventory. Check the recipient before sending a console message with Enter.
   Assign places with the configurator. A plan draft does not start execution.
7. Stop-Bridge.cmd stops this package's bridge. Runtime data is in data/portable and
   logs are in logs. Do not redistribute a used package folder as a clean release.

CODEX CLI (ALTERNATIVE TO DESKTOP)
Install and sign in to Codex CLI yourself. The package includes no CLI executable or login.
Create a Codex agent as above. Write binding.json with id, revision from team.get and:
  "connection": {"provider":"codex", "transport":"codex-cli",
    "workspace":"C:\\Projects\\your-repo", "executable":"C:\\Tools\\codex.exe",
    "sessionId":"YOUR-UNIQUE-UUID", "sandbox":"read-only"}
Use real absolute paths and a unique UUID generated once with [guid]::NewGuid().
sessionId identifies this AgentCraft conversation; the native session is created on first send.
Run runtime/node.exe studio.mjs connection.bind --file binding.json.
Use connection.check with a JSON file containing {"id":"YOUR-AGENT-ID"} to check the
version, required commands and login without a model turn or changes to your project.
Use workspace-write instead of read-only only when this agent should edit the workspace.
Interactive approvals are disabled; sandbox bypass and executable wrappers are not supported.
Pause/Stop wait for the owned process to exit. Resume continues its exact native session.
After a bridge crash, terminate a surviving old CLI process yourself, then check again.
Keep each CLI conversation under one owner. Open-Agent/Desktop handoff is not supported
for this transport. Your CLI configuration and trusted hooks still apply.
Do not copy credentials into binding.json or redistribute a used profile.
Process tests and the installed CLI login probe passed; a manual two-model-session run
is still pending. No model task is launched by connection.check.

SETTINGS AND TEMPLATES
The command desk edits names, appearance, personality and phrases. The launcher
copies personas.example.json only when a new profile has no personas.json.
Set the Claude Code executable and check your login in the settings tab for reviews.
Do not select the graphical application's executable instead of Claude Code.
workspace-template contains neutral instructions, not a configured Claude connection.
Fill PROJECTS.md with your own projects; NOTES.example.md is an empty notes starter
that can be copied as MEMORY.md when separately configuring a workspace.
Copying templates does not grant access or enable shared conversations/planning.

IMPORT YOUR PNG SKIN
Command desk → Appearance → select the agent → Load PNG.
Enter the full path to a real 64×64 PNG, at most 512 KiB.
Apply the appearance, selecting wide/slim arms and the outer skin layer as needed.
The file is copied to the game's config/agentcraft-skins folder as SHA-256.png;
the original file is no longer needed. Selection is saved in config/agentcraft-studio.json.
Custom imports require 64×64. Some bundled 64×32 skins have a separate legacy conversion;
this does not enable legacy custom imports. Six additional skins are labelled Skin 1–6.
Before public distribution, the user must confirm redistribution rights; see SOURCES.txt.

BUILDINGS
The standard package includes no personal building schematics. Put your own .schem
files in the game's config/agentcraft/buildings folder. Use /agentcraft preview <name>,
step outside the preview bounds, then /agentcraft place <name>. Preview remembers the
centre. Placement replaces the whole volume, including schematic air. Back up the world first.

CHECKS AND LIMITATIONS
The builder audits package contents, including nested JARs, before marking it ready.
Personal paths, projects, conversations, memory and accounts are excluded from distribution.
Third-party license notices, including their authors' public contact details, are preserved.
Build and PNG import checks do not establish visual correctness in a running game.
A disconnected bridge does not confirm task completion. Provider permissions and
capabilities depend on the provider's own application.
