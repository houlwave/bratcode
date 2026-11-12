// runs every tests/*.test.js in-process, one summary
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
process.env.BRATCODE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-test-data-'));
process.env.BRATCODE_NO_TUNNEL = '1';
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!only || f.includes(only))).sort();
for (const f of files) await import(pathToFileURL(path.join(dir, f)).href);
const { summary } = await import('./helpers.js');
const failed = summary();
process.exit(failed ? 1 : 0);
