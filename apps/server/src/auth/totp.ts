import { generateSecret, generateURI, verifySync } from 'otplib';

const ISSUER = 'Panel VM';

export const newTotpSecret = (): string => generateSecret();

export const totpUri = (email: string, secret: string): string =>
  generateURI({ issuer: ISSUER, label: email, secret });

/**
 * Verifikasi kode 6 digit (toleransi +-1 langkah 30 detik).
 * Mengembalikan timeStep yang cocok agar pemanggil bisa menolak pemakaian ulang kode yang sama.
 */
export function verifyTotp(secret: string, token: string): number | null {
  if (!/^\d{6}$/.test(token)) return null;
  const r = verifySync({ secret, token, epochTolerance: 30 });
  return r.valid && 'timeStep' in r ? r.timeStep : null;
}
