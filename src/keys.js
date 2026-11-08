// stdin chunk -> list of key events. handles CSI/SS3, alt, ctrl, bracketed paste.

function csi(seq) {
  const fin = seq[seq.length - 1];
  const params = seq.slice(0, -1).split(';').map((n) => parseInt(n, 10));
  const mod = (params[1] || 1) - 1;
  const base = { shift: !!(mod & 1), alt: !!(mod & 2), ctrl: !!(mod & 4) };
  const k = (name, extra = {}) => ({ name, ...base, ...extra });
  switch (fin) {
    case 'A': return k('up');
    case 'B': return k('down');
    case 'C': return k('right');
    case 'D': return k('left');
    case 'H': return k('home');
    case 'F': return k('end');
    case 'Z': return k('tab', { shift: true });
    case 'u':
      if (params[0] === 13) return k('enter');
      if (params[0] === 27) return k('escape');
      if (params[0] === 9) return k('tab');
      if (params[0] === 127) return k('backspace');
      return k('unknown');
    case '~':
      return {
        1: k('home'), 7: k('home'), 3: k('delete'), 4: k('end'), 8: k('end'),
        5: k('pageup'), 6: k('pagedown'),
      }[params[0]] || k('unknown');
    default: return k('unknown');
  }
}

export function parseKeys(s) {
  const keys = [];
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('\x1b[200~', i)) {
      const end = s.indexOf('\x1b[201~', i);
      keys.push({ name: 'paste', text: s.slice(i + 6, end < 0 ? s.length : end) });
      i = end < 0 ? s.length : end + 6;
      continue;
    }
    const ch = s[i];
    if (ch === '\x1b') {
      const n = s[i + 1];
      if (n === '[') {
        let j = i + 2;
        while (j < s.length && !/[@-~]/.test(s[j])) j++;
        keys.push(csi(s.slice(i + 2, j + 1)));
        i = j + 1;
        continue;
      }
      if (n === 'O' && i + 2 < s.length) {
        const m = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' }[s[i + 2]];
        keys.push({ name: m || 'unknown' });
        i += 3;
        continue;
      }
      if (n !== undefined) {
        if (n === '\r' || n === '\n') { keys.push({ name: 'enter', alt: true }); i += 2; continue; }
        const rest = parseKeys(n)[0];
        if (rest) keys.push({ ...rest, alt: true });
        i += 2;
        continue;
      }
      keys.push({ name: 'escape' });
      i++;
      continue;
    }
    const cp = s.codePointAt(i);
    const c = String.fromCodePoint(cp);
    i += c.length;
    if (c === '\r') keys.push({ name: 'enter' });
    else if (c === '\n') keys.push({ name: 'j', ctrl: true });
    else if (c === '\t') keys.push({ name: 'tab' });
    else if (c === '\x7f' || c === '\b') keys.push({ name: 'backspace' });
    else if (cp >= 1 && cp <= 26) keys.push({ name: String.fromCharCode(96 + cp), ctrl: true });
    else if (cp < 32) keys.push({ name: 'unknown' });
    else keys.push({ name: 'char', text: c });
  }
  return keys;
}
