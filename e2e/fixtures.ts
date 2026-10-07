import { test as base, expect } from '@playwright/test';

let counter = 1 + Math.floor(Math.random() * 100);

/** Alamat klien unik per konteks browser (server uji memakai TRUST_PROXY=true), agar rate limit per IP tidak saling mengganggu. */
export function nextClientIp(): string {
  counter += 1;
  return `10.${Math.floor(counter / 250) % 250}.${counter % 250}.7`;
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'X-Forwarded-For': nextClientIp() });
  },
});
export { expect };
