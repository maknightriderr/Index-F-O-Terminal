import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');

describe('top bar', () => {
  it('does not clip its dropdowns: the alert bell opens below the 48px bar, and overflow-hidden on the header hid every notification and left only the count badge', () => {
    const topbar = readFileSync(join(SRC, 'components', 'layout', 'topbar.tsx'), 'utf8');
    const header = /<header[^>]*className="([^"]*)"/.exec(topbar)![1];
    expect(header).not.toMatch(/overflow-(hidden|clip|x-hidden|y-hidden)/);
  });
  it('the bell button is named, announces its popup and reports whether it is open', () => {
    const bell = readFileSync(join(SRC, 'components', 'layout', 'alert-bell.tsx'), 'utf8');
    expect(bell).toMatch(/aria-label=\{/);
    expect(bell).toMatch(/aria-haspopup="true"/);
    expect(bell).toMatch(/aria-expanded=\{open\}/);
  });
});
