import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { generateKeyPair } from '../src/ssh/connect.js';

const { Server } = ssh2;

/** Server SSH palsu: menerima semua kunci, shell mengirim "hello" lalu meng-echo input. */
export async function startFakeSsh(): Promise<{ port: number; close: () => Promise<void> }> {
  const hostKey = generateKeyPair('fake-host').privateKey;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (c) => c.accept());
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acc) => acc && acc());
        session.on('window-change', (acc) => acc && acc());
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('hello\r\n');
          stream.on('data', (d: Buffer) => stream.write(d));
        });
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
