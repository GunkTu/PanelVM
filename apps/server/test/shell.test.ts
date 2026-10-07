import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCommand, inDir, shellQuote } from '../src/ssh/shell.js';

const NASTY = [
  'biasa',
  'dengan spasi',
  "tanda ' kutip",
  'ganda " kutip',
  '$(whoami)',
  '`id`',
  'a; rm -rf /',
  'a && b || c',
  'baris\nbaru',
  '$HOME ${PATH}',
  '\\backslash\\',
  '*?[glob]',
  '~/tilde',
  '-n',
  '--help',
  '',
  "''",
  "'\"'\"'",
  'üñíçødé 😀',
  '#komentar',
  '!histori',
];

describe('shellQuote', () => {
  it('mempertahankan argumen apa adanya saat dijalankan shell sungguhan', () => {
    for (const s of NASTY) {
      const out = execFileSync('sh', ['-c', buildCommand(['printf', '%s', s])]).toString('utf8');
      expect(out, JSON.stringify(s)).toBe(s);
    }
  });

  it('tidak mengeksekusi injeksi', () => {
    const out = execFileSync('sh', [
      '-c',
      buildCommand(['echo', '$(echo BAHAYA)', '; echo BAHAYA2']),
    ]).toString();
    expect(out.trim()).toBe('$(echo BAHAYA) ; echo BAHAYA2');
  });

  it('menolak NUL dan perintah kosong', () => {
    expect(() => shellQuote('a\0b')).toThrow();
    expect(() => buildCommand([])).toThrow();
  });

  it('env dan sudo diterapkan dengan aman', () => {
    expect(buildCommand(['ls'], { sudo: true })).toBe("'sudo' '-n' '--' 'ls'");
    const out = execFileSync('sh', [
      '-c',
      buildCommand(['sh', '-c', 'printf %s "$FOO"'], { env: { FOO: 'a b; c' } }),
    ]).toString();
    expect(out).toBe('a b; c');
    expect(() => buildCommand(['ls'], { env: { 'bad key': 'x' } })).toThrow();
  });

  it('inDir menjalankan perintah di direktori dengan argumen utuh', () => {
    const out = execFileSync('sh', [
      '-c',
      buildCommand(inDir('/tmp', ['sh', '-c', 'pwd; printf %s "$1"', 'x', "a'b"])),
    ]).toString();
    expect(out).toBe("/tmp\na'b");
  });
});
