// OpenTelemetry, loaded before the server (node --import ./dist/instrumentation.js). It
// starts only when an exporter is configured with OpenTelemetry's standard variables, such
// as OTEL_EXPORTER_OTLP_ENDPOINT, so installs without a collector load none of it.
import type { NodeSDK } from '@opentelemetry/sdk-node';
import { register } from 'import-in-the-middle/register-hooks.mjs';

export function telemetryConfigured(env: Readonly<Record<string, string | undefined>>): boolean {
  if (env['OTEL_SDK_DISABLED'] === 'true') return false;
  return (
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] !== undefined || env['OTEL_TRACES_EXPORTER'] !== undefined
  );
}

async function startTelemetry(): Promise<NodeSDK> {
  // Patches ES modules as they load: the same hook OpenTelemetry's ESM support uses, run
  // in-thread through module.registerHooks() (Node 24.11.1 and later).
  register();

  const [
    { NodeSDK },
    { HttpInstrumentation },
    { FastifyOtelInstrumentation },
    { PgInstrumentation },
    { PinoInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/instrumentation-http'),
    import('@fastify/otel'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-pino'),
  ]);

  const sdk = new NodeSDK({
    // OTEL_SERVICE_NAME overrides it, as usual.
    serviceName: 'crm',
    instrumentations: [
      // HTTP spans contain the raw URL. Capability endpoints retain safe request logs
      // and ledger events but must not export the capability to a collector.
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url?.startsWith('/unsubscribe') === true,
      }),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        // ignorePaths logs the raw path at OTEL_LOG_LEVEL=debug in @fastify/otel0.21.1.
        // Redact the attribute instead, including the unmatched-route fallback.
        requestHook: (span, request) => {
          if (request.url.startsWith('/unsubscribe')) {
            span.setAttribute('url.path', '/unsubscribe/[redacted]');
          }
        },
      }),
      new PgInstrumentation(),
      // Puts the trace and span ids on every log line.
      new PinoInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}

/** The running SDK, which the process flushes on shutdown; undefined when not configured. */
export const telemetry = telemetryConfigured(process.env) ? await startTelemetry() : undefined;
