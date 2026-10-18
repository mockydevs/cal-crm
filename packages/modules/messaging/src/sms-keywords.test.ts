// STOP, START and HELP. The rule is ours and is written out in sms-keywords.ts: the whole
// message must be the keyword. A sentence that merely contains "stop" unsubscribes nobody.
import { describe, expect, it } from 'vitest';

import { HELP_KEYWORDS, OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS, smsKeyword } from './sms-keywords.js';

describe('the keyword lists', () => {
  it("are Twilio's documented defaults", () => {
    // https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out
    expect([...OPT_OUT_KEYWORDS].sort()).toEqual(
      ['CANCEL', 'END', 'OPTOUT', 'QUIT', 'REVOKE', 'STOP', 'STOPALL', 'UNSUBSCRIBE'].sort(),
    );
    expect([...OPT_IN_KEYWORDS].sort()).toEqual(['START', 'UNSTOP']);
    expect([...HELP_KEYWORDS]).toEqual(['HELP']);
  });
});

describe('opting out', () => {
  it.each([
    'STOP',
    'stop',
    'Stop',
    'sToP',
    'UNSUBSCRIBE',
    'end',
    'Quit',
    'STOPALL',
    'revoke',
    'OptOut',
    'cancel',
  ])('reads %j as an opt-out', (body) => {
    expect(smsKeyword(body)).toBe('stop');
  });

  it.each([
    '  STOP',
    'STOP  ',
    '\tstop\r\n',
    ' STOP ',
    'STOP.',
    'Stop!',
    '"STOP"',
    '*stop*',
    'STOP!!!',
  ])('ignores space and punctuation around the word: %j', (body) => {
    expect(smsKeyword(body)).toBe('stop');
  });

  it.each([
    "don't stop",
    'stopping by at 5',
    'nonstop',
    'S T O P',
    'S.T.O.P',
    'ST0P',
    'STOP 2',
    'the end',
    'cancel my appointment',
    'ＳＴＯＰ',
    'СТОП',
    'ARRET',
    'alto',
    '',
    '   ',
    '...',
  ])('does not read %j as a keyword', (body) => {
    expect(smsKeyword(body)).toBeNull();
  });
});

describe('the revocations of 47 CFR 64.1200(a)(10)', () => {
  it.each([
    'OPT OUT',
    'opt out',
    'Opt out',
    'opt-out',
    'Opt_Out',
    'OPT-OUT!',
    'un-subscribe',
    'STOP ALL',
    'stop all',
  ])("reads the rule's words in any case and spelling: %j", (body) => {
    expect(smsKeyword(body)).toBe('stop');
  });

  it.each([
    'Please stop texting me',
    'STOP please',
    'stop please!!',
    'Stop texting me, thanks',
    'stop it',
    'STOP STOP',
    'Unsubscribe me',
    'remove me from your list',
    'Take me off your list please',
    "Don't text me again",
    'DO NOT CONTACT ME',
    'no more texts',
    'Leave me alone.',
    'I revoke my consent',
    'stop sending me messages',
    'quit texting me',
    'opt me out',
    'i want to unsubscribe',
  ])('reads %j as a reasonable revocation', (body) => {
    expect(smsKeyword(body)).toBe('stop');
  });

  it.each([
    'cancel my appointment',
    'can you stop by at 5?',
    'please call me',
    'end of the week works',
    'stop sending invoices to my old address',
    "please don't stop the reminders",
    'remove me from the 3pm slot',
    'STOP 2',
    'S T O P',
  ])('leaves %j for a person to read', (body) => {
    expect(smsKeyword(body)).toBeNull();
  });
});

describe('opting in and help', () => {
  it.each(['START', 'start', ' Start. ', 'UNSTOP', 'unstop'])('reads %j as an opt-in', (body) => {
    expect(smsKeyword(body)).toBe('start');
  });

  // "Yes" answers ordinary questions far too often to count as consent to marketing.
  it.each(['YES', 'yes', 'Y', 'ok', 'start now', 'subscribe', 'restart'])(
    'does not read %j as an opt-in',
    (body) => {
      expect(smsKeyword(body)).toBeNull();
    },
  );

  it.each(['HELP', 'help', ' Help? '])('reads %j as a request for help', (body) => {
    expect(smsKeyword(body)).toBe('help');
  });

  it.each(['INFO', 'help me', 'I need help'])('does not read %j as help', (body) => {
    expect(smsKeyword(body)).toBeNull();
  });
});

describe("Twilio's own verdict (OptOutType, sent only with Advanced Opt-Out)", () => {
  it('wins over the text, because the customer may have configured other keywords', () => {
    expect(smsKeyword('ARRET', 'STOP')).toBe('stop');
    expect(smsKeyword('OUI', 'START')).toBe('start');
    expect(smsKeyword('AIDE', 'HELP')).toBe('help');
    expect(smsKeyword('STOP', 'HELP')).toBe('help');
  });

  it('is ignored when it is not one of the three documented values', () => {
    expect(smsKeyword('hello', 'stop')).toBeNull();
    expect(smsKeyword('hello', 'OTHER')).toBeNull();
    expect(smsKeyword('STOP', 'OTHER')).toBe('stop');
    expect(smsKeyword('STOP', '')).toBe('stop');
    expect(smsKeyword('STOP', undefined)).toBe('stop');
  });
});
