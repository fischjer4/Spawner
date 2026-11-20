import { app, safeStorage } from 'electron';
import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// Credentials go only to the launcher's private pipe, never stdout or a file.
app.setName('Spawner');
app.whenReady().then(async () => {
  try {
    const data = join(homedir(), 'Library/Application Support/Spawner');
    const { gateway } = JSON.parse((await safeStorage.decryptStringAsync(await readFile(join(data, 'credentials.bin')))).result);
    if (!gateway) throw new Error('Missing Gateway key');
    const db = new DatabaseSync(join(data, 'spawner.sqlite'), { readOnly: true });
    const settings = JSON.parse((db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value); db.close();
    writeSync(3, JSON.stringify({ gateway, settings }));
    app.exit(0);
  } catch { console.error('Could not unlock the saved Gateway connection. Connect Spawner or set AI_GATEWAY_API_KEY.'); app.exit(1); }
});
