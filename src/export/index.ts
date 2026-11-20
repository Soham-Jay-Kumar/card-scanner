/**
 * The guaranteed routes out of the app. Neither depends on paste behaviour: the
 * .xlsx stores every cell as text in the file itself, and the CSV is literal.
 */
import ExcelJS from 'exceljs';
import { COLUMN_HEADERS, FIELD_KEYS, type CardRow, type ToCsv, type ToXlsx } from '../shared/contracts.ts';

/** Excel's built-in Text format. */
const TEXT_FORMAT = '@';
const COLUMN_WIDTH = 28;
const BYTE_ORDER_MARK = '\uFEFF';

const headers = (): string[] => FIELD_KEYS.map((field) => COLUMN_HEADERS[field]);
const cells = (row: CardRow): string[] => FIELD_KEYS.map((field) => row[field]);

export const toXlsx: ToXlsx = async (rows) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Cards');
  // The column format also covers cells a person adds to the sheet later.
  sheet.columns = FIELD_KEYS.map(() => ({ width: COLUMN_WIDTH, style: { numFmt: TEXT_FORMAT } }));

  for (const values of [headers(), ...rows.map(cells)]) {
    const row = sheet.addRow(values);
    FIELD_KEYS.forEach((_, column) => {
      row.getCell(column + 1).numFmt = TEXT_FORMAT;
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

const csvRecord = (values: string[]): string => `${values.map(csvCell).join(',')}\r\n`;

export const toCsv: ToCsv = (rows) => {
  const records = [headers(), ...rows.map(cells)].map(csvRecord).join('');
  return Buffer.from(BYTE_ORDER_MARK + records, 'utf8');
};
