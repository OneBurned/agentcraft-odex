import { parseArgs } from 'node:util';
import { migrateTeam, restoreTeam } from '../foreman/src/team-migration.js';
import { PROJECT_ROOT } from '../foreman/src/config.js';

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'profile-dir': { type: 'string' }, 'game-dir': { type: 'string' }, 'codex-binding': { type: 'string' }, 'backup-dir': { type: 'string' },
  } });
  if (positionals.length !== 1 || !['apply', 'restore'].includes(positionals[0]!) || Object.values(values).length !== 4)
    throw new Error('migrate-team apply|restore --profile-dir <absolute> --game-dir <absolute> --codex-binding <absolute> --backup-dir <absolute>');
  const options = { profileDir: values['profile-dir']!, gameDir: values['game-dir']!, bindingFile: values['codex-binding']!, backupDir: values['backup-dir']!, projectRoot: PROJECT_ROOT };
  console.log(JSON.stringify(await (positionals[0] === 'apply' ? migrateTeam(options) : restoreTeam(options))));
} catch (e) { console.error(JSON.stringify({ ok: false, error: (e as Error).message })); process.exitCode = 1; }
