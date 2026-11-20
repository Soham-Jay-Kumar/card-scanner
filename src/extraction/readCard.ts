/**
 * One read of one card. Bad model output becomes a failed outcome, never data
 * and never a throw. Nothing here catches exceptions, so JobPauseError from the
 * client reaches the engine untouched.
 */
import { CONFIG } from '../shared/config.ts';
import {
  SCHEMA_NAMES,
  type CardReadData,
  type LlmCallContext,
  type LlmClient,
  type ReadOutcome,
  type ReadVariant,
} from '../shared/contracts.ts';
import { normalizeText } from '../shared/text.ts';
import { READ_INSTRUCTIONS, READ_USER_TEXT, UNREADABLE_MARK } from './prompts.ts';
import { cardReadSchema } from './schema.ts';

function schemaInvalid(variant: ReadVariant, problem: string): ReadOutcome {
  return { ok: false, failure: 'schema_invalid', detail: `Read ${variant}: ${problem}` };
}

function fieldValues(data: CardReadData): string[] {
  return [
    data.name,
    data.position,
    data.company,
    ...data.emails,
    ...data.phones.map((phone) => phone.number),
    ...data.websites,
  ];
}

export async function readCard(
  llm: LlmClient,
  input: { variant: ReadVariant; imagePaths: string[] },
  ctx: LlmCallContext,
): Promise<ReadOutcome> {
  const result = await llm.parse(
    {
      instructions: READ_INSTRUCTIONS,
      userText: READ_USER_TEXT,
      imagePaths: input.imagePaths,
      schema: cardReadSchema,
      schemaName: SCHEMA_NAMES.read,
      reasoningEffort: CONFIG.reasoningEffort.read,
      maxOutputTokens: CONFIG.maxOutputTokens.read,
    },
    ctx,
  );
  if (!result.ok) return { ok: false, failure: result.failure, detail: result.detail };

  const parsed = cardReadSchema.safeParse(result.value);
  if (!parsed.success) return schemaInvalid(input.variant, 'the answer does not match the schema');

  const data = parsed.data;
  if (data.transcript.every((line) => normalizeText(line) === '')) {
    return schemaInvalid(input.variant, 'the transcript is empty');
  }
  // All three reads could repeat the marker identically and pass agreement, so it stops here.
  if (fieldValues(data).some((value) => value.includes(UNREADABLE_MARK))) {
    return schemaInvalid(input.variant, `a field contains the ${UNREADABLE_MARK} marker`);
  }
  return { ok: true, data };
}
