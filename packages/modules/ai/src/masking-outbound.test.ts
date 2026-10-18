// What masking does to a whole request, and what the request log keeps.
import { describe, expect, it } from 'vitest';

import { LOG_TEXT_LIMIT, logOf, maskOutbound, partsLog } from './masking.js';
import { textOf, toolCallsOf, type AiMessage, type AssistantPart } from './provider.js';

const messages: AiMessage[] = [
  { role: 'user', text: 'Reply to jordan@example.com, who called from 0712 345 678.' },
  {
    role: 'assistant',
    parts: [
      {
        type: 'reasoning',
        provider: 'anthropic',
        data: { type: 'thinking', thinking: '', signature: 'AbC+/123456789/==' },
      },
      { type: 'text', text: 'Looking up order 1234567.' },
      {
        type: 'tool_call',
        id: 'toolu_1',
        name: 'find_contacts',
        input: { query: 'order 1234567' },
      },
    ],
  },
  {
    role: 'tool',
    results: [
      { toolCallId: 'toolu_1', text: '{"email":"jordan@example.com","phone":"+254712345678"}' },
      { toolCallId: 'toolu_2', text: 'No such contact.', isError: true },
    ],
  },
];

describe('what leaves for a provider', () => {
  it('masks everything the install wrote: the system prompt, messages and tool results', () => {
    const masked = maskOutbound({
      system: 'You work for Harbor Lights (hello@harborlights.example, +1 415 555 0123).',
      messages,
    });
    expect(masked.system).toBe('You work for Harbor Lights ([email], [phone]).');
    expect(masked.messages[0]).toEqual({
      role: 'user',
      text: 'Reply to [email], who called from [phone].',
    });
    expect(masked.messages[2]).toEqual({
      role: 'tool',
      results: [
        { toolCallId: 'toolu_1', text: '{"email":"[email]","phone":"[phone]"}' },
        { toolCallId: 'toolu_2', text: 'No such contact.', isError: true },
      ],
    });
  });

  it('returns the turn a model wrote exactly as the model wrote it', () => {
    const masked = maskOutbound({ system: '', messages });
    // The provider checks that earlier turns come back unchanged, signature and all. A
    // number the model wrote is not masked either: it came from the provider.
    expect(masked.messages[1]).toBe(messages[1]);
  });

  it('keeps whatever else the request carries', () => {
    const request = { system: 'Call 0712345678', messages: [], model: 'm', maxOutputTokens: 5 };
    expect(maskOutbound(request)).toEqual({ ...request, system: 'Call [phone]' });
  });
});

describe('what is kept in the request log', () => {
  it('masks every text, the model’s too, and keeps no thinking', () => {
    const logged = logOf({
      system: 'Write to hello@harborlights.example.',
      messages: [
        { role: 'user', text: 'Reply to jordan@example.com.' },
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              provider: 'anthropic',
              data: { type: 'thinking', thinking: 'private', signature: 'sig' },
            },
            { type: 'text', text: 'Calling 0712345678.' },
            {
              type: 'tool_call',
              id: 'toolu_1',
              name: 'send_message',
              input: {
                to: ['jordan@example.com'],
                body: { text: 'Call 0712345678' },
                urgent: true,
                retries: 2,
                after: null,
              },
            },
          ],
        },
        {
          role: 'tool',
          results: [{ toolCallId: 'toolu_1', text: 'Sent to jordan@example.com', isError: true }],
        },
      ],
      tools: [
        { name: 'send_message', description: 'Sends', inputSchema: { type: 'object' } },
        { name: 'find_contacts', description: 'Finds', inputSchema: { type: 'object' } },
      ],
    });
    expect(logged).toEqual({
      system: 'Write to [email].',
      messages: [
        { role: 'user', text: 'Reply to [email].' },
        {
          role: 'assistant',
          text: 'Calling [phone].',
          toolCalls: [
            {
              id: 'toolu_1',
              name: 'send_message',
              input: {
                to: ['[email]'],
                body: { text: 'Call [phone]' },
                urgent: true,
                retries: 2,
                after: null,
              },
            },
          ],
        },
        {
          role: 'tool',
          results: [{ toolCallId: 'toolu_1', text: 'Sent to [email]', isError: true }],
        },
      ],
      tools: ['send_message', 'find_contacts'],
    });
    expect(JSON.stringify(logged)).not.toContain('private');
    expect(JSON.stringify(logged)).not.toContain('sig');
  });

  it('logs the parts of a turn the same way, and cuts a very long text short', () => {
    expect(
      partsLog([
        { type: 'text', text: 'Write to ' },
        { type: 'text', text: 'jordan@example.com' },
        { type: 'tool_call', id: 'c1', name: 'count_deals', input: {} },
      ]),
    ).toEqual({
      text: 'Write to [email]',
      toolCalls: [{ id: 'c1', name: 'count_deals', input: {} }],
    });
    const long = logOf({ system: 'x'.repeat(LOG_TEXT_LIMIT + 50), messages: [] });
    expect(long.system).toHaveLength(LOG_TEXT_LIMIT + 1);
    expect(long.system.endsWith('…')).toBe(true);
    expect(long.tools).toEqual([]);
  });
});

describe('reading a turn', () => {
  const parts: AssistantPart[] = [
    { type: 'reasoning', provider: 'anthropic', data: { type: 'thinking' } },
    { type: 'text', text: 'One. ' },
    { type: 'tool_call', id: 'c1', name: 'count_deals', input: {} },
    { type: 'text', text: 'Two.' },
  ];

  it('gives its text and its tool calls', () => {
    expect(textOf(parts)).toBe('One. Two.');
    expect(toolCallsOf(parts)).toEqual([
      { type: 'tool_call', id: 'c1', name: 'count_deals', input: {} },
    ]);
    expect(textOf([])).toBe('');
    expect(toolCallsOf([])).toEqual([]);
  });
});
