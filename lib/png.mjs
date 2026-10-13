// RISQUES — lecture minimale d'une image PNG (13/10/2026)
//
// Sert à lire la COULEUR d'une carte sous un point quand la couche n'expose
// aucune donnée interrogeable (remontée de nappe du BRGM : couche seulement
// dessinée). Couleurs vraies (types 2 et 6) et palette (type 3), 8 bits,
// sans entrelacement — ce que rend MapServer. Aucune dépendance externe.
import { inflateSync } from 'zlib';

export function lirePng(buf) {
  const b = Buffer.from(buf);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('pas une image PNG');
  let o = 8, l = 0, h = 0, prof = 0, type = 0, entrelace = 0, palette = null, transp = null;
  const donnees = [];
  while (o < b.length) {
    const n = b.readUInt32BE(o), t = b.toString('ascii', o + 4, o + 8), c = b.subarray(o + 8, o + 8 + n);
    if (t === 'IHDR') { l = c.readUInt32BE(0); h = c.readUInt32BE(4); prof = c[8]; type = c[9]; entrelace = c[12]; }
    else if (t === 'PLTE') palette = c;
    else if (t === 'tRNS') transp = c;
    else if (t === 'IDAT') donnees.push(c);
    else if (t === 'IEND') break;
    o += 12 + n;
  }
  if (entrelace) throw new Error('PNG entrelacé non pris en charge');
  if (prof !== 8 && !(type === 3 && [1, 2, 4].includes(prof))) throw new Error(`PNG non pris en charge (profondeur ${prof}, type ${type})`);
  const cpp = { 2: 3, 3: 1, 6: 4, 0: 1, 4: 2 }[type];
  if (!cpp) throw new Error(`type de couleur PNG ${type} non pris en charge`);
  // palette à 1, 2 ou 4 bits : on décode les lignes à leur largeur réelle, puis on déplie
  const octetsLigne = type === 3 && prof < 8 ? Math.ceil(l * prof / 8) : l * cpp;
  const brut = inflateSync(Buffer.concat(donnees)), ligne = octetsLigne, px = Buffer.alloc(ligne * h);
  for (let y = 0; y < h; y++) {
    const f = brut[y * (ligne + 1)], src = brut.subarray(y * (ligne + 1) + 1, (y + 1) * (ligne + 1));
    for (let x = 0; x < ligne; x++) {
      const bpp = type === 3 && prof < 8 ? 1 : cpp;
      const a = x >= bpp ? px[y * ligne + x - bpp] : 0, bb = y ? px[(y - 1) * ligne + x] : 0, cc = (x >= bpp && y) ? px[(y - 1) * ligne + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const p = a + bb - cc, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - cc); v += (pa <= pb && pa <= pc) ? a : pb <= pc ? bb : cc; }
      px[y * ligne + x] = v & 255;
    }
  }
  const indice = (x, y) => {
    if (prof === 8) return px[y * ligne + x];
    const bit = x * prof, octet = px[y * ligne + (bit >> 3)], decal = 8 - prof - (bit & 7);
    return (octet >> decal) & ((1 << prof) - 1);
  };
  const pixel = (x, y) => {
    const i = (y * l + x) * cpp;
    if (type === 3) { const k = indice(x, y); return [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2], transp && k < transp.length ? transp[k] : 255]; }
    if (type === 2) return [px[i], px[i + 1], px[i + 2], 255];
    if (type === 6) return [px[i], px[i + 1], px[i + 2], px[i + 3]];
    if (type === 4) return [px[i], px[i], px[i], px[i + 1]];
    return [px[i], px[i], px[i], 255];
  };
  return { largeur: l, hauteur: h, pixel };
}

export const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
