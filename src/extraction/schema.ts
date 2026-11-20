/**
 * The strict structured-output schema for one read of one card.
 *
 * OpenAI produces keys in schema order, so `transcript` must stay first: the
 * model has to read everything before it sorts anything. Every property is
 * required because strict structured outputs do not allow optional fields.
 */
import { z, type ZodType } from 'zod';
import { FIELD_KEYS, type CardReadData } from '../shared/contracts.ts';

export const cardReadSchema = z.strictObject({
  transcript: z.array(z.string()),
  name: z.string(),
  position: z.string(),
  company: z.string(),
  emails: z.array(z.string()),
  phones: z.array(z.strictObject({ number: z.string(), label: z.string() })),
  websites: z.array(z.string()),
  unreadable: z.array(z.enum(FIELD_KEYS)),
}) satisfies ZodType<CardReadData>;
