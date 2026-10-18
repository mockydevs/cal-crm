// Exporting an automation (AUTOMATIONS.md section 5): ids mean nothing in another business,
// so each reference goes out by name, and comes back to an id when the import is validated.
import { describe, expect, it } from 'vitest';

import { portableAutomation, validateAutomation } from './automations-validate.js';
import { harborLights } from './automations-validate.test.js';

const live = {
  name: 'Quote follow-up',
  triggers: [
    { id: 'quote', type: 'form.submitted', config: { form: 'form_quote' } },
    {
      id: 'moved',
      type: 'deal.stage_changed',
      config: { pipeline: 'pipe_events', stage: 'stage_quote' },
    },
  ],
  start: 'send',
  steps: {
    send: {
      type: 'email.send',
      config: { template: 'tmpl_pricing', mailbox: 'mbx_sales' },
      next: 'tag',
    },
    tag: { type: 'tag.add', config: { tag: 'tag_vip' }, next: 'move' },
    move: { type: 'deal.move', config: { pipeline: 'pipe_events', stage: 'stage_won' } },
  },
};

describe('a portable automation', () => {
  it('names every reference instead of giving its id', () => {
    const { document, warnings } = portableAutomation(live, harborLights);
    expect(warnings).toEqual([]);
    expect(document).toEqual({
      ...live,
      triggers: [
        { id: 'quote', type: 'form.submitted', config: { form: 'Request a quote' } },
        {
          id: 'moved',
          type: 'deal.stage_changed',
          config: { pipeline: 'Events', stage: 'Quote sent' },
        },
      ],
      steps: {
        send: {
          type: 'email.send',
          config: { template: 'Pricing guide', mailbox: 'Sales' },
          next: 'tag',
        },
        tag: { type: 'tag.add', config: { tag: 'VIP' }, next: 'move' },
        move: { type: 'deal.move', config: { pipeline: 'Events', stage: 'Booked' } },
      },
    });
  });

  it('comes back to the same ids when validated in a business with the same names', () => {
    const { document } = portableAutomation(live, harborLights);
    const result = validateAutomation(document, harborLights);
    expect(result.document?.steps).toMatchObject({
      send: { config: { template: 'tmpl_pricing', mailbox: 'mbx_sales' } },
      tag: { config: { tag: 'tag_vip' } },
      move: { config: { pipeline: 'pipe_events', stage: 'stage_won' } },
    });
    expect(result.document?.triggers).toMatchObject([
      { config: { form: 'form_quote' } },
      { config: { pipeline: 'pipe_events', stage: 'stage_quote' } },
    ]);
  });

  it('never changes the document it is given', () => {
    const before = JSON.stringify(live);
    portableAutomation(live, harborLights);
    expect(JSON.stringify(live)).toBe(before);
  });

  it('keeps an id it cannot name once, and says so, rather than exporting a name that would not import', () => {
    const twin = {
      ...live,
      steps: {
        send: { type: 'email.send', config: { template: 'tmpl_twin_a' }, next: 'gone' },
        gone: { type: 'tag.add', config: { tag: 'tag_deleted' } },
      },
    };
    const { document, warnings } = portableAutomation(twin, harborLights);
    expect(document['steps']).toMatchObject({
      send: { config: { template: 'tmpl_twin_a' } },
      gone: { config: { tag: 'tag_deleted' } },
    });
    expect(warnings).toEqual([
      expect.objectContaining({ path: '/steps/send/config/template', code: 'not_portable' }),
      expect.objectContaining({ path: '/steps/gone/config/tag', code: 'not_portable' }),
    ]);
  });

  it('leaves names, unfinished parts and unknown step types as written', () => {
    const rough = {
      name: 'Rough',
      triggers: 'soon',
      steps: {
        named: { type: 'tag.add', config: { tag: 'VIP' } },
        odd: { type: 'not.a.step', config: { tag: 'tag_vip' } },
        bare: { type: 'tag.add' },
        text: 'later',
      },
    };
    expect(portableAutomation(rough, harborLights)).toEqual({ document: rough, warnings: [] });
  });
});
