import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

interface Props {
  vmId: string;
  active: boolean;
  onState: (s: ConnState, message?: string) => void;
}

const MAX_RETRIES = 5;
const CHUNK = 32 * 1024;

export function TerminalView({ vmId, active, onState }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onStateRef = useRef(onState);
  useEffect(() => {
    onStateRef.current = onState;
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 14,
      theme: { background: '#0a0f1e', foreground: '#e2e8f0', cursor: '#f5b700' },
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();

    let ws: WebSocket | null = null;
    let retries = 0;
    let disposed = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let serverClosed = false;

    const send = (m: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    const connect = () => {
      serverClosed = false;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(
        `${proto}://${location.host}/api/vms/${vmId}/terminal?cols=${term.cols}&rows=${term.rows}`,
      );
      ws.binaryType = 'arraybuffer';
      onStateRef.current(retries ? 'reconnecting' : 'connecting');

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return term.write(new Uint8Array(ev.data as ArrayBuffer));
        const m = JSON.parse(ev.data) as { t: string; state?: string; message?: string };
        if (m.t !== 'status') return;
        if (m.state === 'connected') {
          retries = 0;
          onStateRef.current('connected');
        } else if (m.state === 'error') {
          serverClosed = true;
          onStateRef.current('error', m.message);
        } else if (m.state === 'closed') {
          serverClosed = true;
          onStateRef.current('closed', m.message);
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (disposed || serverClosed) return;
        // Putus tanpa alasan dari server (jaringan): coba sambung ulang bertahap.
        if (retries >= MAX_RETRIES)
          return onStateRef.current(
            'closed',
            'Koneksi terputus. Muat ulang tab untuk mencoba lagi.',
          );
        retries += 1;
        onStateRef.current('reconnecting');
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retries, 15000));
      };
      ws.onopen = () => {
        ping = setInterval(() => send({ t: 'ping' }), 25_000);
      };
    };

    const dataSub = term.onData((d) => {
      for (let i = 0; i < d.length; i += CHUNK) send({ t: 'input', d: d.slice(i, i + CHUNK) });
    });
    const resizeSub = term.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0) fit.fit();
    });
    ro.observe(el);

    connect();
    return () => {
      disposed = true;
      clearInterval(ping);
      clearTimeout(retryTimer);
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [vmId]);

  useEffect(() => {
    if (active) fitRef.current?.fit();
  }, [active]);

  return (
    <div ref={host} className={`h-[68vh] w-full bg-[#0a0f1e] p-2 ${active ? '' : 'hidden'}`} />
  );
}
