import { lookup } from 'node:dns/promises';
import { connect, createSecureContext, type SecureContext } from 'node:tls';
import { GenericContainer, Wait } from 'testcontainers';

const IMAGE =
  'greenmail/standalone:2.1.9@sha256:3ac5a83dd6727cf95e4d50e18907fb8ee7bbf5f67e8534714dee2fb1b5b2e1d4';
const SMTP_PORT = 3465;
const IMAP_PORT = 3993;
const SMTP_STARTTLS_PORT = 3025;
const IMAP_STARTTLS_PORT = 3143;
const API_PORT = 8080;

export interface GreenMailServer {
  readonly address: string;
  readonly smtpPort: number;
  readonly imapPort: number;
  readonly smtpStarttlsPort: number;
  readonly imapStarttlsPort: number;
  readonly username: string;
  readonly password: string;
  readonly ca: string;
  /** Ephemeral fixture identity for protocol peers that exercise STARTTLS upgrades. */
  readonly tlsContext: SecureContext;
  /**
   * GreenMail's own HTTP API, such as http://host:port. Its document is served there as
   * /greenmail-openapi.yml; GET /api/user/{emailOrId}/messages/{folderName} lists a mailbox.
   */
  readonly apiUrl: string;
}

/** Trust bootstrap for this disposable test container only; never used by product code. */
async function fixtureCertificate(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false });
    socket.setTimeout(10_000, () => {
      socket.destroy(new Error('Fixture TLS timed out.'));
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw;
      socket.destroy();
      const lines = raw.toString('base64').match(/.{1,64}/g);
      if (lines === null) {
        reject(new Error('Fixture returned no certificate.'));
        return;
      }
      resolve(`-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`);
    });
  });
}

/** Authenticated SMTP/IMAP over TLS, with a disposable user and a trusted fixture CA. */
export async function startGreenMail(domain = 'localhost'): Promise<{
  server: GreenMailServer;
  stop: () => Promise<void>;
}> {
  const username = 'fixture';
  const password = 'fixture-only-password';
  let startupOutput = '';
  const container = await new GenericContainer(IMAGE)
    // GreenMail requires configured user domains to resolve. Keep fixture domains local.
    .withExtraHosts([{ host: domain, ipAddress: '127.0.0.1' }])
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand([
      'keytool -genkeypair -alias fixture -keyalg RSA -keysize 2048 -dname CN=localhost -ext SAN=dns:localhost -validity 2 -storetype PKCS12 -keystore /tmp/fixture.p12 -storepass fixture-only-password -keypass fixture-only-password && exec /home/greenmail/run_greenmail.sh',
    ])
    .withEnvironment({
      // CI proved GreenMail aborts TLS startup at its own 2s deadline under load.
      // The pinned builder accepts milliseconds; the outer readiness deadline stays 60s.
      GREENMAIL_OPTS: `-Dgreenmail.startup.timeout=20000 -Dgreenmail.setup.test.smtps -Dgreenmail.setup.test.imaps -Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=${username}:${password}@${domain} -Dgreenmail.tls.keystore.file=/tmp/fixture.p12 -Dgreenmail.tls.keystore.password=fixture-only-password`,
      JAVA_OPTS: '-Djava.net.preferIPv4Stack=true -Xmx128m',
    })
    .withExposedPorts(SMTP_PORT, IMAP_PORT, SMTP_STARTTLS_PORT, IMAP_STARTTLS_PORT, API_PORT)
    // Testcontainers removes failed containers before start() rejects. Keep a bounded
    // tail beforehand so CI can distinguish a JVM exit from an HTTP/network timeout.
    .withLogConsumer((stream) => {
      stream.on('data', (chunk: string) => {
        startupOutput = (startupOutput + chunk).slice(-8192);
      });
      stream.on('error', () => {
        startupOutput = (startupOutput + '\nFixture log stream failed.').slice(-8192);
      });
    })
    // GreenMail2.1.9 starts sockets before creating configured users. Its standalone
    // HTTP server starts afterward; readiness therefore includes user initialization.
    .withWaitStrategy(
      Wait.forHttp('/api/service/readiness', API_PORT, { abortOnContainerExit: true }),
    )
    .start()
    .catch(() => {
      // The launcher prints JAVA_OPTS, including this disposable fixture password.
      // Do not attach Testcontainers' raw exit error, which can include the same logs.
      throw new Error(
        `GreenMail fixture startup failed. Startup output:\n${startupOutput.replaceAll(password, '[redacted]')}`,
      );
    });
  try {
    const { address } = await lookup(container.getHost(), { family: 4 });
    const smtpPort = container.getMappedPort(SMTP_PORT);
    const identity = await container.exec(['base64', '/tmp/fixture.p12']);
    if (identity.exitCode !== 0) throw new Error('Could not read the disposable TLS identity.');
    const tlsContext = createSecureContext({
      pfx: Buffer.from(identity.stdout, 'base64'),
      passphrase: 'fixture-only-password',
      minVersion: 'TLSv1.2',
    });
    return {
      server: {
        address,
        smtpPort,
        imapPort: container.getMappedPort(IMAP_PORT),
        smtpStarttlsPort: container.getMappedPort(SMTP_STARTTLS_PORT),
        imapStarttlsPort: container.getMappedPort(IMAP_STARTTLS_PORT),
        username,
        password,
        ca: await fixtureCertificate(address, smtpPort),
        tlsContext,
        apiUrl: `http://${address}:${String(container.getMappedPort(API_PORT))}`,
      },
      stop: async () => {
        await container.stop();
      },
    };
  } catch (failure) {
    await container.stop();
    throw failure;
  }
}
