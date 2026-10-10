import type { FilterId } from './imaging/filters';

export const FILTERS: { id: FilterId; label: string; hint: string }[] = [
  {
    id: 'document',
    label: 'Document',
    hint: 'Black text on white, logos, stamps and photos kept in colour',
  },
  { id: 'bw', label: 'B&W', hint: 'Pure black text on pure white' },
  { id: 'gray', label: 'Grey', hint: 'Clean white paper, greyscale content and photos' },
  { id: 'color', label: 'Colour', hint: 'Shadows removed, full colour, paper in its own colour' },
  { id: 'original', label: 'Original', hint: 'Perspective correction only' },
];
