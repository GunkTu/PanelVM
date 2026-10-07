/** Opsi rate limit per route (per IP). Endpoint berat/mahal diberi batas lebih ketat dari bawaan global. */
export const rateLimit = (max: number, timeWindow = '1 minute') => ({
  rateLimit: { max, timeWindow },
});
