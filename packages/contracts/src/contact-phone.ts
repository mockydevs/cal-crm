import * as z from 'zod';

/** A displayed phone identity shared by contacts and opportunities. */
export const contactPhone = z
  .looseObject({
    number: z.string().meta({ description: 'In E.164.', examples: ['+254712345678'] }),
    display: z.string().meta({
      description: "As people write it: national form in the business's country.",
      examples: ['0712 345678'],
    }),
  })
  .meta({ id: 'ContactPhone' });

export type ContactPhone = z.infer<typeof contactPhone>;
