/** Every card in the scan, with flagged cells marked. Click a row to look at the card. */
import { useState } from 'react';

import type { CardSummary } from './api.ts';
import { StatusLabel } from './ui.tsx';
import { COLUMN_HEADERS, FIELD_KEYS } from '../shared/contracts.ts';
import type { Card } from '../shared/contracts.ts';

type Filter = 'all' | Card['status'];

const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['verified', 'Verified'],
  ['confirmed', 'Confirmed by you'],
  ['needs_review', 'Needs checking'],
  ['failed', 'Failed'],
  ['rejected', 'Removed'],
];

export function CardsTable({ cards, onOpen }: { cards: CardSummary[]; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');

  if (cards.length === 0) {
    return (
      <div className="empty">
        <h2>No cards yet</h2>
        <p>Cards appear here as soon as the app finds them in your images.</p>
      </div>
    );
  }

  const shown = filter === 'all' ? cards : cards.filter((card) => card.status === filter);

  return (
    <>
      <div className="filters">
        {FILTERS.filter(([key]) => key === 'all' || cards.some((card) => card.status === key)).map(([key, label]) => (
          <button key={key} className="filter" type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {FIELD_KEYS.map((field) => <th key={field}>{COLUMN_HEADERS[field]}</th>)}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((card) => (
              <tr key={card.id} className="clickable" onClick={() => onOpen(card.id)}>
                {FIELD_KEYS.map((field) => (
                  <td key={field} className={`cell ${card.flaggedFields.includes(field) && card.status === 'needs_review' ? 'flagged' : ''}`}>
                    {card.row?.[field] || <span className="blank">Blank</span>}
                  </td>
                ))}
                <td>
                  <StatusLabel status={card.status} />
                  {card.possibleDuplicateOf && <div className="hint">Possible duplicate</div>}
                  {card.error && <div className="hint">{card.error}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
