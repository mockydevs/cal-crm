import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.int.test.ts'],
    reporters: ['default', 'junit'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      // Pure scoring and policy need no network; integration measures their storage users.
      include: [
        'src/score.ts',
        'src/outbound-policy.ts',
        'src/mailbox-admission.ts',
        'src/campaign-rules.ts',
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
