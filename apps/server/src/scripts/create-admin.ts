import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { passwordSchema } from '../auth/passwords.js';
import { createUser } from '../auth/users.js';
import { loadEnv } from '../config/env.js';
import { migrate, openDb } from '../db/index.js';
import { AppError } from '../errors.js';

function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
    muted = hidden;
  });
}

const env = loadEnv();
const db = openDb(env.DATABASE_PATH);
migrate(db);

try {
  const email = (await ask('Email admin: ')).trim();
  const password = await ask('Password (min. 12 karakter): ', true);
  const confirm = await ask('Ulangi password: ', true);
  if (password !== confirm)
    throw new Error('Password dan konfirmasi tidak sama. Jalankan ulang perintah ini.');
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Password tidak valid.');
  const user = await createUser(db, { email, password, role: 'admin' });
  console.log(
    `Admin dibuat: ${user.email}. Saat login pertama Anda akan diminta mengaktifkan 2FA.`,
  );
} catch (e) {
  console.error(e instanceof AppError || e instanceof Error ? e.message : 'Gagal membuat admin.');
  process.exitCode = 1;
} finally {
  db.close();
}
