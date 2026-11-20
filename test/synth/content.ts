/**
 * What is printed on each synthetic card, and the exact answer for it.
 * The answers are written out here by hand, never produced by code in src/.
 */
import { MULTI_VALUE_SEPARATOR } from '../../src/shared/contracts.ts';
import type { CardReadData, CardRow } from '../../src/shared/contracts.ts';
import { PHONE_CASES } from '../../src/paste/phoneCases.ts';
import type { Difficulty } from './truth.ts';

export type Layout = 'left' | 'center' | 'split' | 'band' | 'vertical';

export interface Design {
  layout: Layout;
  font: string;
  background: string;
  ink: string;
  accent: string;
  logo: 'circle' | 'square' | 'diamond' | 'bars' | 'none';
}

export interface CardContent {
  key: string;
  difficulty: Difficulty;
  tags: string[];
  name: string;
  position: string;
  company: string;
  emails: string[];
  phones: Array<{ number: string; label: string }>;
  websites: string[];
  /** Printed on the card but belonging to no column. */
  extraLines: string[];
  design: Design;
  expectedStatus?: 'verified' | 'needs_review';
}

const DESIGNS: Design[] = [
  { layout: 'left', font: "'Helvetica Neue', Helvetica, Arial", background: '#fdfcf8', ink: '#1a1c20', accent: '#b5482a', logo: 'circle' },
  { layout: 'center', font: 'Georgia, serif', background: '#f4efe6', ink: '#2c2a26', accent: '#6b5b3e', logo: 'none' },
  { layout: 'split', font: "'Avenir Next', Avenir, Arial", background: '#ffffff', ink: '#20242b', accent: '#1f4f8f', logo: 'square' },
  { layout: 'band', font: "'Gill Sans', 'Gill Sans MT', Arial", background: '#fbfbfb', ink: '#222222', accent: '#2d6a4f', logo: 'bars' },
  { layout: 'left', font: "'Times New Roman', Times, serif", background: '#14171c', ink: '#f2f2ee', accent: '#d9a441', logo: 'diamond' },
  { layout: 'center', font: "'Courier New', Courier, monospace", background: '#ececec', ink: '#111111', accent: '#7a2e2e', logo: 'square' },
  { layout: 'band', font: "Futura, 'Trebuchet MS', Arial", background: '#10243e', ink: '#f6f6f2', accent: '#e07a3f', logo: 'circle' },
  { layout: 'split', font: "Baskerville, Georgia, serif", background: '#fffdf5', ink: '#30261c', accent: '#8a3b12', logo: 'diamond' },
];
const VERTICAL: Design = { layout: 'vertical', font: "'Helvetica Neue', Arial", background: '#ffffff', ink: '#1c1f24', accent: '#3a5a40', logo: 'circle' };
const VERTICAL_DARK: Design = { layout: 'vertical', font: 'Georgia, serif', background: '#1b1b1f', ink: '#f4f1ea', accent: '#c58f3d', logo: 'diamond' };

type Spec = Partial<Omit<CardContent, 'key' | 'difficulty' | 'tags'>> & Pick<CardContent, 'key' | 'difficulty' | 'tags'>;

function card(spec: Spec, index: number): CardContent {
  return {
    name: '',
    position: '',
    company: '',
    emails: [],
    phones: [],
    websites: [],
    extraLines: [],
    design: DESIGNS[index % DESIGNS.length]!,
    ...spec,
  };
}

const tel = (number: string, label = 'Tel') => ({ number, label });

const SPECS: Spec[] = [
  /* Plain cards. */
  { key: 'maya-chen', difficulty: 'easy', tags: ['plain'], name: 'Maya Chen', position: 'Product Manager', company: 'Northwind Labs', emails: ['maya.chen@northwindlabs.com'], phones: [tel('+1 415 555 0132')], websites: ['www.northwindlabs.com'], expectedStatus: 'verified' },
  { key: 'luis-ortega', difficulty: 'easy', tags: ['plain'], name: 'Luis Ortega', position: 'Sales Director', company: 'Ortega Freight Co.', emails: ['luis@ortegafreight.com'], phones: [tel('+1 312 555 0147', 'Mobile')], websites: ['ortegafreight.com'], expectedStatus: 'verified' },
  { key: 'priya-nair', difficulty: 'easy', tags: ['plain'], name: 'Priya Nair', position: 'Head of Design', company: 'Lotus Studio', emails: ['priya@lotusstudio.in'], phones: [tel('+91 98765 43210')], websites: ['https://lotusstudio.in'], expectedStatus: 'verified' },
  { key: 'tom-weber', difficulty: 'easy', tags: ['vertical'], name: 'Tom Weber', position: 'Architect', company: 'Weber + Stein GmbH', emails: ['tom@weberstein.de'], phones: [tel('+49 30 901820')], websites: ['www.weberstein.de'], design: VERTICAL },
  { key: 'sara-lind', difficulty: 'easy', tags: ['dark', 'vertical'], name: 'Sara Lind', position: 'Curator', company: 'Galleri Nord', emails: ['sara@gallerinord.se'], phones: [tel('+46 8 123 456 78')], websites: ['gallerinord.se'], design: VERTICAL_DARK },
  { key: 'owen-hart', difficulty: 'easy', tags: ['dark'], name: 'Owen Hart', position: 'Founder', company: 'Hart & Sons Coffee', emails: ['owen@hartandsons.coffee'], phones: [tel('+61 2 9374 4000', 'P')], websites: ['hartandsons.coffee'] },

  /* Credentials, faxes, several values. */
  { key: 'jane-doe-phd', difficulty: 'medium', tags: ['credentials'], name: 'Dr. Jane Doe, PhD', position: 'Chief Medical Officer', company: 'Harbor Health Group', emails: ['jane.doe@harborhealth.org'], phones: [tel('+1 617 555 0118')], websites: ['www.harborhealth.org'] },
  { key: 'prof-adeyemi', difficulty: 'medium', tags: ['credentials'], name: 'Prof. Tunde Adeyemi, MBBS, FRCS', position: 'Consultant Surgeon', company: 'Lagos Teaching Hospital', emails: ['t.adeyemi@lth.org.ng'], phones: [tel('+234 803 123 4567')] },
  { key: 'fax-line', difficulty: 'medium', tags: ['fax'], name: 'Helen Marsh', position: 'Office Manager', company: 'Marsh & Pike Solicitors', emails: ['helen@marshpike.co.uk'], phones: [tel('+44 20 7946 0958'), tel('+44 20 7946 0959', 'Fax')], websites: ['www.marshpike.co.uk'] },
  { key: 'fax-short-label', difficulty: 'medium', tags: ['fax'], name: 'Kenji Mori', position: 'Trade Manager', company: 'Mori Shipping KK', emails: ['k.mori@morishipping.jp'], phones: [tel('+81 3-1234-5678', 'T'), tel('+81 3-1234-5679', 'F')], websites: ['morishipping.jp'] },
  { key: 'many-values', difficulty: 'medium', tags: ['multi-email', 'multi-phone'], name: 'Carlos Vega', position: 'Regional Director', company: 'Vega Logistics SA', emails: ['carlos@vegalogistics.mx', 'ventas@vegalogistics.mx'], phones: [tel('+52 55 1234 5678', 'Office'), tel('+52 1 55 8765 4321', 'Mobile')], websites: ['www.vegalogistics.mx', 'www.vegacargo.mx'] },
  { key: 'no-website', difficulty: 'medium', tags: ['no-website'], name: 'Grace Okafor', position: 'Accountant', company: 'Okafor & Co', emails: ['grace@okaforandco.com'], phones: [tel('+234 802 555 0199')] },
  { key: 'no-email', difficulty: 'medium', tags: ['no-email'], name: 'Paul Dubois', position: 'Plumber', company: 'Dubois Plomberie', phones: [tel('+33 1 42 68 53 00')] },
  { key: 'tagline', difficulty: 'medium', tags: ['slogan'], name: 'Nina Rossi', position: 'Creative Lead', company: 'Studio Rossi', emails: ['nina@studiorossi.it'], phones: [tel('+39 02 1234 5678')], websites: ['studiorossi.it'], extraLines: ['Ideas that travel well', 'Via Torino 12, 20123 Milano'] },

  /* Two scripts and non-Latin names. */
  { key: 'bilingual-zh', difficulty: 'hard', tags: ['bilingual'], name: 'Wei Zhang', position: 'General Manager', company: 'Sunrise Trading Co.', emails: ['wei.zhang@sunrisetrading.cn'], phones: [tel('+86 21 5555 0123')], websites: ['www.sunrisetrading.cn'], extraLines: ['张伟', '总经理', '日出贸易有限公司'] },
  { key: 'bilingual-ar', difficulty: 'hard', tags: ['bilingual'], name: 'Omar Haddad', position: 'Managing Partner', company: 'Haddad Consulting', emails: ['omar@haddadconsulting.ae'], phones: [tel('+971 4 123 4567')], websites: ['haddadconsulting.ae'], extraLines: ['عمر حداد', 'شريك إداري'] },
  { key: 'name-japanese', difficulty: 'hard', tags: ['non-latin'], name: '山田太郎', position: '営業部長', company: '山田商事株式会社', emails: ['yamada@yamadashoji.jp'], phones: [tel('03-1234-5678', '電話')], websites: ['yamadashoji.jp'] },
  { key: 'name-hindi', difficulty: 'hard', tags: ['non-latin'], name: 'तुलिका प्रसाद', position: 'प्रबंध निदेशक', company: 'प्रसाद एंटरप्राइजेज', emails: ['tulika@prasadent.in'], phones: [tel('+91 98765 43211')] },
  { key: 'name-russian', difficulty: 'hard', tags: ['non-latin'], name: 'Иван Петров', position: 'Директор', company: 'ООО «Северный Путь»', emails: ['ivan@severput.ru'], phones: [tel('+7 495 123-45-67')], websites: ['severput.ru'] },

  /* Lookalike characters. */
  { key: 'rn-m-barnes', difficulty: 'hard', tags: ['lookalike', 'rn-m'], name: 'Fern Barnes', position: 'Modern Furniture Buyer', company: 'Barnwell Mornings', emails: ['fern.barnes@barnwellmornings.com'], phones: [tel('+1 503 555 0171')], websites: ['www.barnwellmornings.com'] },
  { key: 'rn-m-acme', difficulty: 'hard', tags: ['lookalike', 'rn-m'], name: 'Kim Bernard', position: 'Warehouse Manager', company: 'Acme Turnkey Ltd', emails: ['kim.bernard@acme.example.com'], phones: [tel('+1 720 555 0126')], websites: ['acme.example.com'] },
  { key: 'zero-o', difficulty: 'hard', tags: ['lookalike', '0-O'], name: "Otto O'Connor", position: 'CTO', company: '0xygen Labs', emails: ['otto@0xygenlabs.io'], phones: [tel('+1 206 555 0100')], websites: ['www.0xygenlabs.io'] },
  { key: 'one-l', difficulty: 'hard', tags: ['lookalike', 'l-1'], name: 'Bill Illingworth', position: 'Partner', company: 'Hillside 11 Capital', emails: ['bill@hillside11.com'], phones: [tel('+1 212 555 0111')], websites: ['www.hillside11.com'] },

  /* Cards the rules must send to a person. */
  { key: 'no-name', difficulty: 'hard', tags: ['no-name'], position: 'Customer Service', company: 'Bluebird Couriers', emails: ['info@bluebirdcouriers.com'], phones: [tel('+1 800 555 0142')], websites: ['bluebirdcouriers.com'], expectedStatus: 'needs_review' },
  { key: 'unsafe-at', difficulty: 'hard', tags: ['unsafe-start'], name: 'Rita Moreno', position: 'Agent', company: '@Home Realty', emails: ['rita@athomerealty.com'], phones: [tel('+1 305 555 0154')], websites: ['athomerealty.com'], expectedStatus: 'needs_review' },
  { key: 'unsafe-equals', difficulty: 'hard', tags: ['unsafe-start'], name: 'Sam Reyes', position: '=SUM Analyst', company: 'Ledger Works', emails: ['sam@ledgerworks.com'], phones: [tel('+1 214 555 0161')], websites: ['ledgerworks.com'], expectedStatus: 'needs_review' },
  { key: 'domain-near-miss', difficulty: 'hard', tags: ['near-miss-false-alarm'], name: 'Dana Kerr', position: 'Sales Lead', company: 'Brightwave', emails: ['dana@brightwave.co'], phones: [tel('+1 408 555 0183')], websites: ['www.brightwave.com'], expectedStatus: 'needs_review' },
];

/** Every phone style from the paste test set, three to a card. */
function phoneStyleCards(): Spec[] {
  const numbers = PHONE_CASES.filter((item) => item.kind === 'phone').flatMap((item) => item.value.split(MULTI_VALUE_SEPARATOR));
  const specs: Spec[] = [];
  for (let start = 0; start < numbers.length; start += 3) {
    const index = specs.length + 1;
    specs.push({
      key: `phone-styles-${index}`,
      difficulty: 'hard',
      tags: ['phone-style'],
      name: `Phone Case ${String.fromCharCode(64 + index)}`,
      position: 'Test Contact',
      company: 'Dialtone Partners',
      emails: [`contact${String.fromCharCode(96 + index)}@dialtonepartners.com`],
      phones: numbers.slice(start, start + 3).map((number) => ({ number, label: '' })),
      websites: ['www.dialtonepartners.com'],
    });
  }
  return specs;
}

export const CARD_CONTENT: CardContent[] = [...SPECS, ...phoneStyleCards()].map(card);

/* ------------------------------------------------------------------ */
/* Generated people, for sheets and the 1,000-card job                 */
/* ------------------------------------------------------------------ */

const FIRST = 'Aisha Ben Clara Diego Elena Farid Gina Hugo Irene Jonas Katya Liam Marta Nikhil Olga Pablo Quinn Rosa Stefan Tara Umar Vera Wes Ximena Yusuf Zoe Anton Bianca Cesar Dalia Emil Freya Goran Hana Ivan Julia Kofi Lena Mateo Noor Oscar'.split(' ');
const LAST = 'Abbott Becker Castro Dalton Ellis Fischer Garcia Hughes Ibrahim Jensen Keller Larsen Mendes Novak Owens Patel Quigley Ramos Silva Tanaka Ueda Vargas Walsh Xu Yates Zimmer Adler Bishop Cortes Duarte Evans Foster Greene Holt Ingram Jung Kaur Lowe Moss Nash Ortiz Price Reed'.split(' ');
const ROLE = ['Account Manager', 'Project Lead', 'Senior Engineer', 'Operations Director', 'Marketing Manager', 'Financial Analyst', 'Regional Sales Lead', 'Customer Success Manager', 'Procurement Officer', 'Partner'];
const COMPANY: Array<[string, string]> = [
  ['Alder Systems', 'aldersystems.com'],
  ['Birchwood Partners', 'birchwoodpartners.com'],
  ['Cobalt Freight', 'cobaltfreight.com'],
  ['Delta Harbor Group', 'deltaharbor.com'],
  ['Evergreen Supply', 'evergreensupply.com'],
  ['Foxglove Media', 'foxglovemedia.com'],
  ['Granite Peak Advisors', 'granitepeak.com'],
  ['Hazel & Finch', 'hazelfinch.com'],
  ['Ironbridge Tools', 'ironbridgetools.com'],
  ['Juniper Health', 'juniperhealth.com'],
  ['Keystone Print', 'keystoneprint.com'],
  ['Larkspur Foods', 'larkspurfoods.com'],
];

/** One made-up person. The same id always gives the same card, and no two share an email or phone. */
export function generatedPerson(id: number): CardContent {
  const first = FIRST[id % FIRST.length]!;
  const last = LAST[(id * 7) % LAST.length]!;
  const [company, domain] = COMPANY[id % COMPANY.length]!;
  return {
    key: `person-${id}`,
    difficulty: 'easy',
    tags: ['generated'],
    name: `${first} ${last}`,
    position: ROLE[id % ROLE.length]!,
    company,
    emails: [`${first.toLowerCase()}.${last.toLowerCase()}@${domain}`],
    phones: [{ number: `+1 415 555 ${String(id % 10_000).padStart(4, '0')}`, label: 'Tel' }],
    websites: [`www.${domain}`],
    extraLines: [],
    design: DESIGNS[id % DESIGNS.length]!,
  };
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

/** The label as it appears on the card, before the number. */
export function phoneLine(phone: { number: string; label: string }): string {
  return phone.label ? `${phone.label}: ${phone.number}` : phone.number;
}

export function printedLines(content: CardContent): string[] {
  return [
    content.name,
    content.position,
    content.company,
    ...content.phones.map(phoneLine),
    ...content.emails,
    ...content.websites,
    ...content.extraLines,
  ].filter(Boolean);
}

const isFax = (label: string) => /^(fax|f)$/i.test(label);

export function rowOf(content: CardContent): CardRow {
  return {
    name: content.name,
    position: content.position,
    company: content.company,
    email: content.emails.join(MULTI_VALUE_SEPARATOR),
    phone: content.phones.filter((phone) => !isFax(phone.label)).map((phone) => phone.number).join(MULTI_VALUE_SEPARATOR),
    website: content.websites.join(MULTI_VALUE_SEPARATOR),
  };
}

/** What a perfect reader returns. Fax numbers are listed, as the prompt asks, and toRow removes them. */
export function perfectRead(content: CardContent): CardReadData {
  return {
    transcript: printedLines(content),
    name: content.name,
    position: content.position,
    company: content.company,
    emails: [...content.emails],
    phones: content.phones.map((phone) => ({ ...phone })),
    websites: [...content.websites],
    unreadable: [],
  };
}
