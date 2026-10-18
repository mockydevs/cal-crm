import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { TLSSocket, type SecureContext } from 'node:tls';

/** RFC 3207/9051 peers: real TLS upgrades, with credentials accepted only after encryption. */
export async function startTlsPeer(
  protocol: 'smtp' | 'imap',
  secureContext: SecureContext,
  username: string,
  password: string,
  submission?: number | 'disconnect',
): Promise<{
  port: number;
  authentications: boolean[];
  stop: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const authentications: boolean[] = [];
  const expected = `\0${username}\0${password}`;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write(protocol === 'smtp' ? '220 localhost fixture\r\n' : '* OK fixture ready\r\n');
    function listen(peer: Socket, encrypted: boolean): void {
      let saslTag: string | undefined;
      let receiving = false;
      const lines = createInterface({ input: peer, crlfDelay: Infinity });
      lines.on('error', () => undefined);
      peer.once('close', () => {
        lines.close();
      });
      lines.on('line', (line) => {
        if (receiving) {
          if (line === '.') {
            if (submission === 'disconnect') peer.destroy();
            else peer.write(`${String(submission)} fixture-private-response\r\n`);
            receiving = false;
          }
          return;
        }
        if (saslTag !== undefined) {
          const accepted = encrypted && Buffer.from(line, 'base64').toString() === expected;
          authentications.push(accepted);
          peer.write(`${saslTag} ${accepted ? 'OK' : 'NO'} authentication completed\r\n`);
          saslTag = undefined;
          return;
        }
        const [first, command, mechanism, initial] = line.split(' ');
        if (protocol === 'smtp') {
          if (first === 'EHLO')
            peer.write(`250-localhost\r\n250 ${encrypted ? 'AUTH PLAIN' : 'STARTTLS'}\r\n`);
          else if (first === 'STARTTLS' && !encrypted) upgrade('220 Ready for TLS\r\n');
          else if (first === 'AUTH') {
            const accepted =
              encrypted && Buffer.from(mechanism ?? '', 'base64').toString() === expected;
            authentications.push(accepted);
            peer.write(
              accepted ? '235 Authentication successful\r\n' : '535 Authentication failed\r\n',
            );
          } else if (
            submission !== undefined &&
            encrypted &&
            (first === 'MAIL' || first === 'RCPT')
          )
            peer.write('250 Accepted\r\n');
          else if (submission !== undefined && encrypted && first === 'DATA') {
            receiving = true;
            peer.write('354 End with a dot\r\n');
          } else if (first === 'QUIT') peer.end('221 Bye\r\n');
          else peer.write('500 Command not supported\r\n');
          return;
        }
        if (first === undefined) throw new Error('Missing IMAP tag.');
        if (command === 'CAPABILITY')
          peer.write(
            `* CAPABILITY IMAP4rev1 ${encrypted ? 'AUTH=PLAIN SASL-IR' : 'STARTTLS LOGINDISABLED'}\r\n${first} OK CAPABILITY completed\r\n`,
          );
        else if (command === 'STARTTLS' && !encrypted) upgrade(`${first} OK Begin TLS\r\n`);
        else if (command === 'AUTHENTICATE' && mechanism === 'PLAIN') {
          if (initial === undefined) {
            saslTag = first;
            peer.write('+ \r\n');
          } else {
            const accepted = encrypted && Buffer.from(initial, 'base64').toString() === expected;
            authentications.push(accepted);
            peer.write(`${first} ${accepted ? 'OK' : 'NO'} authentication completed\r\n`);
          }
        } else if (command === 'LOGOUT')
          peer.end(`* BYE Closing\r\n${first} OK LOGOUT completed\r\n`);
        else peer.write(`${first} BAD Command not supported\r\n`);
        function upgrade(reply: string): void {
          lines.close();
          peer.write(reply);
          const secured = new TLSSocket(peer, { isServer: true, secureContext });
          sockets.add(secured);
          secured.once('close', () => sockets.delete(secured));
          secured.on('error', () => undefined);
          listen(secured, true);
        }
      });
    }
    listen(socket, false);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port.');
  return {
    port: address.port,
    authentications,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    },
  };
}
