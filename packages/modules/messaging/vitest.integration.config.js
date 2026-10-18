import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Sending combines pure admission/routing with database/provider composition.
    // Measure its existing boundary tests alongside the integration tests for that file.
    include: ['src/**/*.int.test.ts', 'src/sms-send.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 180_000,
    testTimeout: 60_000,
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit-integration.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/integration',
      include: ['src/**/*.ts'],
      // Pure scoring and policy are measured by units; these paths need actual storage/mail.
      exclude: [
        'src/**/*.test.ts',
        'src/score.ts',
        'src/outbound-policy.ts',
        'src/mailbox-admission.ts',
        'src/campaign-rules.ts',
        // Provider parsing, signing and HTTP ports are measured by the required unit gate.
        // SMS commands, storage and sending composition remain measured here.
        'src/twilio-api.ts',
        'src/voice/twilio-voice.ts',
        'src/voice/voice-progress.ts',
        'src/voice/voice-terminal.ts',
        'src/voice/voice-twiml.ts',
        'src/voice/device-token.ts',
        'src/voice/voice-url.ts',
        'src/voice/voice-request.ts',
        'src/voice/voice-routing.ts',
        'src/voice/voice-signing-key.ts',
        'src/voice/number-provider.ts',
        'src/twilio-form.ts',
        'src/twilio-signature.ts',
        'src/twilio-status.ts',
        'src/sms-keywords.ts',
        'src/sms-webhook-url.ts',
        'src/sms-webhook-verify.ts',
        'src/inbox-rules.ts',
        'src/webchat-origin.ts',
        'src/webchat-policy.ts',
        'src/webchat-token.ts',
        'src/email-report-rules.ts',
        'src/email-html.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
