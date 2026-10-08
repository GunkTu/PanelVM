import { describe, expect, it } from 'vitest';
import { formatRemaining } from './format';

describe('formatRemaining', () => {
  const now = 1_000_000_000_000;
  const min = 60_000;

  it('menampilkan Berakhir bila waktu sudah lewat atau tepat sekarang', () => {
    expect(formatRemaining(now - 1, now)).toBe('Berakhir');
    expect(formatRemaining(now, now)).toBe('Berakhir');
  });

  it('menampilkan menit, jam, dan hari dalam Bahasa Indonesia', () => {
    expect(formatRemaining(now + 10_000, now)).toBe('1 menit');
    expect(formatRemaining(now + 45 * min, now)).toBe('45 menit');
    expect(formatRemaining(now + 135 * min, now)).toBe('2 jam 15 menit');
    expect(formatRemaining(now + 26 * 60 * min, now)).toBe('1 hari 2 jam');
    expect(formatRemaining(now + 48 * 60 * min, now)).toBe('2 hari');
  });
});
