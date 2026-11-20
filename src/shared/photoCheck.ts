/**
 * Which uploaded images a person must look at before anything can be copied.
 * Shared by the server, which enforces it, and the web app, which shows it.
 *
 * A card missed by both locate passes is invisible to every automatic check, so
 * any image holding several cards needs a person to confirm the count. That is
 * the only defence against a silently missing row.
 */
import type { SourceFile } from './contracts.ts';

export function photoNeedsCheck(file: SourceFile): boolean {
  if (file.stage === 'failed' || file.stage === 'duplicate') return false;
  const locate = file.locate;
  if (locate?.checkedByPerson) return false;
  if (file.stage === 'no_card') return true;
  if (!locate) return false;
  return !locate.countConfirmed || locate.fellBackToFullImage || locate.locations.length >= 2;
}
