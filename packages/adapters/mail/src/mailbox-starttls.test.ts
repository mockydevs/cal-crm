import { createServer, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { createMailboxConnector } from './index.js';

// Deliberately non-compliant peers exercise mandatory TLS, using RFC 3207/9051 wire replies.
it.each(['smtp', 'imap'] as const)(
  'never sends credentials when %s refuses STARTTLS',
  async (protocol) => {
    const sockets = new Set<Socket>();
    const commands: string[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.write(protocol === 'smtp' ? '220 localhost fixture\r\n' : '* OK fixture ready\r\n');
      const lines = createInterface({ input: socket, crlfDelay: Infinity });
      lines.on('line', (line) => {
        commands.push(line);
        if (protocol === 'smtp') {
          if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line === 'STARTTLS') socket.write('454 TLS unavailable\r\n');
        } else {
          const [tag, command] = line.split(' ');
          if (tag === undefined) throw new Error('Missing IMAP command tag.');
          if (command === 'CAPABILITY')
            socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK CAPABILITY completed\r\n`);
          else if (command === 'STARTTLS') socket.write(`${tag} BAD STARTTLS unavailable\r\n`);
        }
      });
      socket.once('close', () => {
        lines.close();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing fixture port.');
      const login = {
        host: '127.0.0.1',
        port: address.port,
        security: 'starttls' as const,
        username: 'fixture-private-user',
        password: 'fixture-private-password',
      };
      const blocked = { ...login, host: '10.0.0.1' };
      const result = await createMailboxConnector({
        allowedPrivateHosts: ['127.0.0.1'],
        timeoutMs: 1000,
      }).verify(
        protocol === 'smtp' ? { smtp: login, imap: blocked } : { smtp: blocked, imap: login },
      );
      const selected = result[protocol];
      expect(selected.code).toBe('tls_required');
      expect(commands.join('\n')).not.toContain(login.username);
      expect(commands.join('\n')).not.toContain(login.password);
      expect(commands.join('\n')).not.toMatch(/AUTH(?:ENTICATE)?\s|LOGIN\s/i);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
  },
);
