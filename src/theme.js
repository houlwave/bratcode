import { hex } from './term.js';

const c = hex;

// the whole identity: one green, one black, one white.
export const THEMES = {
  brat: {
    name: 'brat',
    bg: c('#8ACE00'),
    fg: c('#000000'),
    dim: c('#2E4A00'),
    faint: c('#4F7A00'),
    panel: c('#0B0B0B'),
    panelFg: c('#FFFFFF'),
    panelDim: c('#6F9230'),
    bar: c('#FFFFFF'),
    accent: c('#8ACE00'),
    accentFg: c('#000000'),
    logoA: c('#000000'),
    logoB: c('#000000'),
  },
  dark: {
    name: 'dark',
    bg: c('#0A0A0A'),
    fg: c('#EDEDED'),
    dim: c('#8C8C8C'),
    faint: c('#5C5C5C'),
    panel: c('#171717'),
    panelFg: c('#FFFFFF'),
    panelDim: c('#6A6A6A'),
    bar: c('#8ACE00'),
    accent: c('#8ACE00'),
    accentFg: c('#000000'),
    logoA: c('#8ACE00'),
    logoB: c('#FFFFFF'),
  },
};

export const MODES = {
  brat: { label: 'brat', color: c('#8ACE00'), blurb: 'fast, loud, ships it' },
  demure: { label: 'demure', color: c('#F3B6D6'), blurb: 'very mindful, very cutesy, plans first' },
};
