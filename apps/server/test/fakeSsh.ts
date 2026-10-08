import net, { type AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { generateKeyPair } from '../src/ssh/connect.js';

const { Server } = ssh2;

/** Server SSH palsu: menerima semua kunci, shell mengirim "hello" lalu meng-echo input. */
export interface FakeSsh {
  port: number;
  hostKey: string;
  close: () => Promise<void>;
}

export async function startFakeSsh(
  opts: { port?: number; hostKey?: string; forbidForwarding?: boolean } = {},
): Promise<FakeSsh> {
  const hostKey = opts.hostKey ?? generateKeyPair('fake-host').privateKey;
  const conns = new Set<{ end: () => void }>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    conns.add(client);
    client.on('close', () => conns.delete(client));
    client.on('error', () => {});
    client.on('authentication', (c) => c.accept());
    client.on('ready', () => {
      // Port-forward (direct-tcpip) ke loopback: dipakai fitur preview. Penolakan meniru OpenSSH.
      // Tanpa listener, ssh2 menjawab ADMINISTRATIVELY_PROHIBITED seperti sshd dengan AllowTcpForwarding no.
      if (!opts.forbidForwarding)
        client.on('tcpip', (accept, reject, info) => {
          const sock = net.connect(info.destPort, info.destIP);
          sock.once('connect', () => {
            const ch = accept();
            ch.pipe(sock).pipe(ch);
            ch.on('close', () => sock.destroy());
            sock.on('close', () => ch.destroy());
          });
          sock.once('error', () => reject());
        });
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acc) => {
          const stream = acc();
          stream.exit(0);
          stream.end();
        });
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
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    hostKey,
    close: () =>
      new Promise<void>((r) => {
        for (const c of conns) c.end(); // putuskan koneksi yang masih terbuka
        server.close(() => r());
      }),
  };
}
