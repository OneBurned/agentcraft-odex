// Full shipped Setup.cmd dialogs, real Windows process checks and real Fabric metadata.
// Opt-in: installs only under a new caller-selected trial directory; no process-probe mocks.
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { inspectRelease, verifyFabric } from '../lib/portable-install.mjs';
const [sourceArg, trialArg, fabricArg, optIn] = process.argv.slice(2);
if (!sourceArg || !trialArg || !fabricArg || optIn !== '--live') throw Error('setup-live <package> <new trial directory> <real Fabric JSON> --live');
const source = path.resolve(sourceArg), trial = path.resolve(trialArg), fabric = path.resolve(fabricArg);
const release = await inspectRelease(source); const metadata = await verifyFabric(fabric, release.build);
await fs.mkdir(trial); // Refuse to reuse an existing trial.
assert.equal((await fs.realpath(trial)).toLowerCase(), realpathSync(trial).toLowerCase(), 'Windows redirected this trial folder. Use a new directory under Documents instead of virtualized AppData.');
const repo = path.join(trial, 'project'); await fs.mkdir(repo);
const git = (...args) => execFileSync('git', ['-c', 'user.name=Trial', '-c', 'user.email=trial@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, windowsHide: true, stdio: 'pipe' });
git('init'); await fs.writeFile(path.join(repo, 'README.md'), '# Disposable acceptance project\n'); git('add', '.'); git('commit', '-m', 'Initial fixture');
const results = [];
for (const language of ['ru', 'en']) {
  const target = path.join(trial, `installation-${language}`), game = path.join(trial, `game-${language}`); await fs.mkdir(game);
  const answers = [language === 'ru' ? '1' : '2', '1', target, game, fabric, repo, '', '', '', 'YES'];
  const child = spawn('cmd.exe', ['/d', '/c', path.join(source, 'Setup.cmd')], { cwd: source, windowsHide: true, stdio: 'pipe' });
  let output = '', errors = '', promptCount = 0, answered = 0, finished = false;
  child.stdout.on('data', bytes => {
    output += bytes.toString();
    const count = [...output.matchAll(/\n> /g)].length;
    while (promptCount < count) {
      promptCount++;
      if (answered >= answers.length) { child.kill(); return; }
      child.stdin.write(answers[answered++] + '\n');
    }
    if (!finished && /Ready\. Run Start-Bridge|Готово\. Запусти Start-Bridge/.test(output)) { finished = true; child.stdin.end('\n'); }
  });
  child.stderr.on('data', bytes => errors += bytes.toString()); child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill(), 90000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  await fs.writeFile(path.join(trial, `setup-${language}.log`), output + '\n' + errors);
  assert.equal(code, 0, `Setup ${language} exit; inspect local log`); assert(finished, `Setup ${language} did not finish`); assert.equal(answered, 10);
  const installed = JSON.parse(await fs.readFile(path.join(target, 'installation.json')));
  const team = JSON.parse(await fs.readFile(path.join(target, 'data/portable/team.json')));
  assert.equal(installed.game, game); assert.equal(team.agents.length, 0);
  for (const mod of release.mods) assert.deepEqual(await fs.readFile(path.join(source, mod.name)), await fs.readFile(path.join(game, 'mods', path.basename(mod.name))));
  results.push({ language, fullDialog: true, promptsAnswered: answered, realProcessProbe: true, fabric: metadata, emptyTeam: true, modHashesMatch: true });
  console.log(`Full Setup.cmd ${language}: passed.`);
}
await fs.writeFile(path.join(trial, 'setup-result.json'), JSON.stringify({ passed: true, results }, null, 2));
console.log(JSON.stringify({ passed: true, results, evidence: path.join(trial, 'setup-result.json') }));
