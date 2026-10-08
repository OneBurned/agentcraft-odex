import fs from 'node:fs';
import path from 'node:path';

export const maintenanceFile = (profile: string) => `${path.resolve(profile)}.migration-lock.json`;
export function assertProfileAvailable(profile: string) {
  if (fs.existsSync(maintenanceFile(profile)))
    throw new Error('Профиль переносится или восстановление не завершено. Заверши перенос либо выполни migrate-team restore с резервной копией.');
}
