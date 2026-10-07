import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';

const env = loadEnv();
const { app } = await buildApp(env);
if (env.INSECURE_HTTP) {
  app.log.warn(
    'INSECURE_HTTP aktif: cookie sesi TIDAK aman (tanpa HTTPS). Hanya untuk uji jaringan lokal; matikan sebelum dibuka ke internet.',
  );
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
