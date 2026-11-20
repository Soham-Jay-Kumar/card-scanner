/** Scriptable stand-ins for the vision, extraction and decision services. */
import { join } from 'node:path';
import {
  FIELD_KEYS,
  READ_VARIANTS,
  type CardCrop,
  type CardDecision,
  type CardReadData,
  type CardRow,
  type DecisionService,
  type ExtractionService,
  type FieldConsensusMap,
  type LlmCallContext,
  type LocateResult,
  type QualityReport,
  type ReadImages,
  type ReadOutcome,
  type ReadRecord,
  type ReadVariant,
  type VisionService,
} from '../../shared/contracts.ts';

export type VisionStep = 'normalize' | 'assessQuality' | 'locate' | 'crop' | 'prepareReadImages';

export interface FilePlan {
  /** Cards in this image. 0 means no card was found. Defaults to 1. */
  cards?: number;
  /** Throw at this step. */
  failAt?: VisionStep;
}

const GOOD_REPORT: QualityReport = { ok: true, width: 1_600, height: 900, blurScore: 500, meanLuminance: 120, issues: [] };

export interface FakeVisionOptions {
  /** Plans by original file name. */
  plans?: Record<string, FilePlan>;
  /** Report for one crop. */
  cropQuality?: (imagePath: string, index: number) => QualityReport;
  /** Runs at the start of each step, for delays and pause points. */
  before?: (step: VisionStep, detail: string, ctx?: LlmCallContext) => Promise<void> | void;
}

export function fakeVision(options: FakeVisionOptions = {}): VisionService & { calls: Array<{ step: VisionStep; detail: string }> } {
  const calls: Array<{ step: VisionStep; detail: string }> = [];
  const planFor = (path: string): FilePlan => {
    const name = path.split('/').at(-1)?.replace(/\.norm\.jpg$/, '') ?? '';
    return options.plans?.[name] ?? {};
  };
  const step = async (name: VisionStep, path: string, ctx?: LlmCallContext): Promise<void> => {
    calls.push({ step: name, detail: path });
    await options.before?.(name, path, ctx);
    if (planFor(path).failAt === name) throw new Error(`${name} failed for ${path}`);
  };

  return {
    calls,
    async normalize({ originalName, outDir }) {
      const path = join(outDir, `${originalName}.norm.jpg`);
      await step('normalize', path);
      return { path, width: 4_000, height: 3_000, sourceFormat: 'jpeg' };
    },
    async assessQuality(image) {
      await step('assessQuality', image.path);
      return GOOD_REPORT;
    },
    async locate(image, ctx): Promise<LocateResult> {
      await step('locate', image.path, ctx);
      const count = planFor(image.path).cards ?? 1;
      const locations = Array.from({ length: count }, (_, i) => ({
        box: { x: i * 10, y: 0, width: 10, height: 10 },
        rotation: 0 as const,
      }));
      return { noCard: count === 0, locations, fellBackToFullImage: false, countConfirmed: true, note: null };
    },
    async crop(image, locate, outDir): Promise<CardCrop[]> {
      await step('crop', image.path);
      return locate.locations.map((location, index) => ({
        path: join(outDir, `crop-x${location.box.x}.jpg`),
        width: 1_600,
        height: 900,
        side: 'single',
        quality: options.cropQuality?.(image.path, index) ?? GOOD_REPORT,
      }));
    },
    async prepareReadImages(crop): Promise<ReadImages> {
      await step('prepareReadImages', crop.path);
      return { A: `${crop.path}.A`, B: `${crop.path}.B`, C: `${crop.path}.C` };
    },
  };
}

export const SAMPLE_READ: CardReadData = {
  transcript: ['Jane Doe', 'Engineer', 'Acme'],
  name: 'Jane Doe',
  position: 'Engineer',
  company: 'Acme',
  emails: ['jane@acme.com'],
  phones: [{ number: '+1 555 123 4567', label: 'Tel' }],
  websites: ['acme.com'],
  unreadable: [],
};

export interface ReadCall {
  cardId: string;
  variant: ReadVariant;
  imagePaths: string[];
}

export function fakeExtraction(
  read: (input: ReadCall, ctx: LlmCallContext) => Promise<ReadOutcome> | ReadOutcome = () => ({ ok: true, data: SAMPLE_READ }),
): ExtractionService & { calls: ReadCall[] } {
  const calls: ReadCall[] = [];
  return {
    calls,
    async readCard(input, ctx) {
      const call = { cardId: ctx.cardId ?? '', ...input };
      calls.push(call);
      return read(call, ctx);
    },
    compare(reads: ReadRecord[]): FieldConsensusMap {
      return Object.fromEntries(
        FIELD_KEYS.map((field) => [
          field,
          {
            field,
            values: { A: null, B: null, C: null },
            agreement: reads.every((record) => record.outcome.ok) && reads.length === 3 ? 'unanimous' : 'split',
            chosen: '',
            candidates: [],
            unreadable: false,
          },
        ]),
      ) as unknown as FieldConsensusMap;
    },
    toRow(data): CardRow {
      return { name: data.name, position: data.position, company: data.company, email: '', phone: '', website: '' };
    },
  };
}

export function fakeDecision(): DecisionService & { calls: Array<Parameters<DecisionService['decide']>[0]> } {
  const calls: Array<Parameters<DecisionService['decide']>[0]> = [];
  return {
    calls,
    async decide(input): Promise<CardDecision> {
      calls.push(input);
      const allRead = READ_VARIANTS.every((variant) => input.reads.some((read) => read.variant === variant && read.outcome.ok));
      const verified = allRead && (input.quality?.ok ?? false);
      return {
        status: verified ? 'verified' : 'needs_review',
        row: { name: 'Jane Doe', position: 'Engineer', company: 'Acme', email: 'jane@acme.com', phone: '', website: '' },
        consensus: input.consensus,
        checks: [],
        flaggedFields: verified ? [] : ['name'],
      };
    },
  };
}
