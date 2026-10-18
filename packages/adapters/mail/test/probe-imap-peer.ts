import { createServer } from 'node:net';
import { TLSSocket, type SecureContext } from 'node:tls';

export type ProbeScenario =
  | 'missing'
  | 'duplicate'
  | 'missing_source'
  | 'missing_size'
  | 'underreported_size'
  | 'missing_uid_next'
  | 'invalid_uid_next'
  | 'stalled_second_source'
  | 'oversize'
  | 'oversize_literal'
  | 'delayed';

/** A TLS protocol boundary fixture for RFC9051 EXAMINE, UID SEARCH and BODY.PEEK. */
export async function startProbeImapPeer(
  context: SecureContext,
  scenario: ProbeScenario,
): Promise<{
  readonly port: number;
  readonly searches: number;
  recoverSource(): void;
  stop(): Promise<void>;
}> {
  const sockets = new Set<TLSSocket>();
  let searches = 0;
  let recovered = false;
  const server = createServer((raw) => {
    // Match the established STARTTLS peer's supported TLSSocket context boundary.
    const socket = new TLSSocket(raw, { isServer: true, secureContext: context });
    raw.on('error', () => undefined);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write('* OK fixture ready\r\n');
    let buffer = '';
    let authenticationTag: string | undefined;
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (authenticationTag !== undefined) {
          socket.write(`${authenticationTag} OK authenticated\r\n`);
          authenticationTag = undefined;
          continue;
        }
        const [tag = '', command = ''] = line.split(' ');
        if (command === 'CAPABILITY')
          socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK capability\r\n`);
        else if (command === 'AUTHENTICATE') {
          authenticationTag = tag;
          socket.write('+ \r\n');
        } else if (command === 'LOGIN') socket.write(`${tag} OK authenticated\r\n`);
        else if (command === 'LIST') socket.write(`* LIST () "/" "INBOX"\r\n${tag} OK listed\r\n`);
        else if (command === 'LSUB') socket.write(`${tag} OK listed\r\n`);
        else if (command === 'EXAMINE')
          socket.write(
            `* FLAGS (\\Seen)\r\n* ${scenario === 'stalled_second_source' ? '2' : '1'} EXISTS\r\n* OK [UIDVALIDITY 1]\r\n${scenario === 'missing_uid_next' ? '' : `* OK [UIDNEXT ${scenario === 'invalid_uid_next' ? '0' : scenario === 'stalled_second_source' ? '3' : '2'}]\r\n`}${tag} OK [READ-ONLY] examined\r\n`,
          );
        else if (/^UID SEARCH /i.test(line.slice(tag.length + 1))) {
          searches += 1;
          const ids =
            scenario === 'duplicate'
              ? '1 2'
              : scenario === 'missing' || (scenario === 'delayed' && searches === 1)
                ? ''
                : '1';
          socket.write(`* SEARCH${ids === '' ? '' : ` ${ids}`}\r\n${tag} OK searched\r\n`);
        } else if (/^UID FETCH /i.test(line.slice(tag.length + 1))) {
          const source = 'From: fixture@localhost\r\nSubject: Fixture\r\n\r\nFixture body.\r\n';
          if (scenario === 'stalled_second_source') {
            if (!/BODY/i.test(line)) {
              const range = /^\S+ UID FETCH (\d+):/i.exec(line)?.[1];
              const ids = range === '2' ? [2] : [1, 2];
              socket.write(
                ids
                  .map(
                    (uid) =>
                      `* ${String(uid)} FETCH (UID ${String(uid)} RFC822.SIZE ${String(Buffer.byteLength(source))})\r\n`,
                  )
                  .join('') + `${tag} OK fetched\r\n`,
              );
            } else if (/UID FETCH 1 /i.test(line) || recovered) {
              const uid = /UID FETCH 1 /i.test(line) ? 1 : 2;
              socket.write(
                `* ${String(uid)} FETCH (UID ${String(uid)} BODY[] {${String(Buffer.byteLength(source))}}\r\n${source})\r\n${tag} OK fetched\r\n`,
              );
            }
            continue;
          }
          const size =
            scenario === 'oversize' && !recovered
              ? 600_000
              : scenario === 'underreported_size'
                ? 5
                : Buffer.byteLength(source);
          const reportedSize =
            scenario === 'missing_size' && !recovered ? '' : ` RFC822.SIZE ${String(size)}`;
          if (scenario === 'oversize_literal')
            socket.write('* 1 FETCH (UID 1 RFC822.SIZE 600000 BODY[] {600000}\r\n');
          else if (scenario === 'missing_source' && !recovered)
            socket.write(`* 1 FETCH (UID 1 RFC822.SIZE 0)\r\n${tag} OK fetched\r\n`);
          else
            socket.write(
              `* 1 FETCH (UID 1${reportedSize} BODY[] {${String(Buffer.byteLength(source))}}\r\n${source})\r\n${tag} OK fetched\r\n`,
            );
        } else if (command === 'LOGOUT') socket.end(`* BYE closing\r\n${tag} OK logout\r\n`);
        else socket.write(`${tag} BAD unsupported fixture command\r\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No fixture listener.');
  return {
    port: address.port,
    get searches() {
      return searches;
    },
    recoverSource() {
      recovered = true;
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
