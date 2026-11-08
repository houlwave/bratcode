import { hex } from './term.js';

// black stage, brat accents. green is the album, pink is the b-side.
export const C = {
  bg: hex('#000000'),
  fg: hex('#F2F2F2'),
  text: hex('#CFCFCF'),
  dim: hex('#808080'),
  faint: hex('#333333'),
  panel: hex('#151515'),
  green: hex('#8ACE00'),
  pink: hex('#F3B6D6'),
  hot: hex('#FF4FA3'),
};

export const MODES = {
  brat: { id: 'brat', side: 'a', label: 'brat', color: C.green, blurb: 'fast, loud, ships it' },
  demure: { id: 'demure', side: 'b', label: 'demure', color: C.pink, blurb: 'calm, very mindful, plans first' },
};
