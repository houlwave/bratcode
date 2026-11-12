// tiny test harness (zero deps)
let passed = 0, failed = 0;
const fails = [];
export async function test(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; fails.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`); }
}
export function summary() {
  console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) { console.log(fails.map((f) => ' - ' + f).join('\n')); process.exitCode = 1; }
  return failed;
}
export const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
export const ok = (c, m = 'assertion failed') => { if (!c) throw new Error(m); };
export const has = (s, sub, m = '') => { if (!String(s).includes(sub)) throw new Error(`${m} expected to contain ${JSON.stringify(sub)} in: ${String(s).slice(0, 300)}`); };
