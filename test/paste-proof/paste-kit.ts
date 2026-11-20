/**
 * For the person running CHECKLIST.md. This is the one file under test/ that uses
 * the real Mac clipboard, so no automated test runs it.
 *
 *   node test/paste-proof/paste-kit.ts copy    puts the test set on the clipboard
 *   node test/paste-proof/paste-kit.ts check   compares what you copied back from the sheet
 */
import { createPasteService } from '../../src/paste/index.ts';
import { phoneCaseRows } from '../../src/paste/phoneCases.ts';

const paste = createPasteService();
const rows = phoneCaseRows();
const command = process.argv[2];

if (command === 'copy') {
  const result = await paste.writeClipboard(paste.encode(rows, { includeHeader: true }));
  console.log(result.verified ? `Ready: ${rows.length} rows and a header are on the clipboard. Now paste into the sheet.` : `Failed: ${result.detail}`);
  process.exitCode = result.verified ? 0 : 1;
} else if (command === 'check') {
  const { plain } = await paste.readClipboard();
  const report = paste.verifyPaste(rows, plain);
  console.log(`Rows expected ${report.rowsExpected}, found ${report.rowsFound}, cells compared ${report.cellsCompared}.`);
  for (const difference of report.differences) {
    console.log(`Row ${difference.row}, ${difference.field}: expected "${difference.expected}", got "${difference.actual}" (${difference.kind})`);
  }
  console.log(report.ok ? 'PASS: every cell is identical.' : `FAIL: ${report.differences.length} cells differ.`);
  process.exitCode = report.ok ? 0 : 1;
} else {
  console.log('Use: node test/paste-proof/paste-kit.ts copy   or   node test/paste-proof/paste-kit.ts check');
}
