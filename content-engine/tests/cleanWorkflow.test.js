import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/clean-video.yml'), 'utf8');
const checkedOut = [...workflow.matchAll(/^\s+(content-engine\/\S+)\s*$/gm)].map((m) => m[1]);

/** Every local file a script reaches through its imports. */
function reach(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"\n]*from\s+['"](\.[^'"]+)['"]/gm)) {
    const next = resolve(dirname(file), m[1]);
    if (existsSync(next)) reach(next, seen);
  }
  return seen;
}

describe('the Clean workflow checkout', () => {
  it('holds every file the clean script imports', () => {
    const files = [...reach(resolve(ROOT, 'content-engine/scripts/gha-clean.mjs'))].map((f) => relative(ROOT, f).split(sep).join('/'));
    const missing = files.filter((f) => !checkedOut.some((p) => f === p || f.startsWith(`${p}/`)));
    expect(checkedOut.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
