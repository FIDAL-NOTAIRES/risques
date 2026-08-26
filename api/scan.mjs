// RISQUES — /api/scan.mjs
//
// Balayage a la recherche des prescriptions 54-01 et 54-02 (zones exposees au
// recul du trait de cote) et des cartes de prefiguration (pre-ZERTC).
//
// POURQUOI CE CHANGEMENT DE METHODE
// La version precedente interrogeait douze communes candidates choisies a
// l'estime. Aucune ne portait de zone : la liste etait une hypothese, non une
// source. Plutot que de deviner, on balaye l'emprise d'un departement littoral
// entier.
//
// METHODE
// Le module GPU s'interroge par geometrie. Une emprise departementale complete
// renverrait des milliers d'entites et serait tronquee par la limite de
// restitution. L'emprise est donc decoupee en GRILLE, et chaque maille est
// interrogee separement. Toute maille dont le nombre d'entites atteint la
// limite est signalee comme POSSIBLEMENT TRONQUEE : le resultat est alors
// incomplet, et il faut resserrer la grille.
//
// Ce que ce balayage etablit : ou se trouvent les zones du 7°.
// Ce qu'il n'etablit pas : si un bien donne y est situe. La qualification se
// fait sur parcelle, via /api/gpu.
//
// Usage :
//   /api/scan?dep=33
//   /api/scan?dep=85&grille=6
//   /api/scan?bbox=-1.6,46.0,-1.0,46.5
//   /api/scan                      -> liste les departements disponibles

const IGN_GPU = 'https://apicarto.ign.fr/api/gpu';
const LIMITE = 1000;
const CODES_CIBLE = ['54-01', '54-02'];

// Rectangles englobants approximatifs des departements littoraux
// (longitude min, latitude min, longitude max, latitude max, en WGS84).
// Valeurs approchees : elles servent a delimiter un balayage, non a qualifier.
const DEPARTEMENTS = {
  '62': { nom: 'Pas-de-Calais',        bbox: [1.55, 50.02, 3.19, 51.01] },
  '80': { nom: 'Somme',                bbox: [1.37, 49.57, 3.19, 50.37] },
  '76': { nom: 'Seine-Maritime',       bbox: [0.06, 49.24, 1.79, 50.07] },
  '14': { nom: 'Calvados',             bbox: [-1.15, 48.75, 0.45, 49.44] },
  '50': { nom: 'Manche',               bbox: [-1.95, 48.44, -0.75, 49.73] },
  '35': { nom: 'Ille-et-Vilaine',      bbox: [-2.29, 47.63, -1.933, 48.7] },
  '22': { nom: 'Cotes-d\'Armor',       bbox: [-3.65, 48.03, -1.95, 48.90] },
  '29': { nom: 'Finistere',            bbox: [-5.15, 47.70, -3.37, 48.75] },
  '56': { nom: 'Morbihan',             bbox: [-3.55, 47.28, -2.02, 48.14] },
  '44': { nom: 'Loire-Atlantique',     bbox: [-2.56, 46.86, -0.93, 47.83] },
  '85': { nom: 'Vendee',               bbox: [-2.40, 46.26, -0.47, 47.09] },
  '17': { nom: 'Charente-Maritime',    bbox: [-1.60, 45.05, -0.03, 46.38] },
  '33': { nom: 'Gironde',              bbox: [-1.32, 44.19, 0.32, 45.58] },
  '40': { nom: 'Landes',               bbox: [-1.53, 43.48, 0.00, 44.53] },
  '64': { nom: 'Pyrenees-Atlantiques', bbox: [-1.79, 42.79, -0.13, 43.60] },
  '66': { nom: 'Pyrenees-Orientales',  bbox: [1.72, 42.33, 3.18, 42.92] },
  '11': { nom: 'Aude',                 bbox: [1.68, 42.65, 3.22, 43.46] },
  '34': { nom: 'Herault',              bbox: [2.53, 43.21, 4.19, 43.98] },
  '30': { nom: 'Gard',                 bbox: [3.26, 43.45, 4.85, 44.34] },
  '13': { nom: 'Bouches-du-Rhone',     bbox: [4.23, 43.16, 5.81, 43.99] },
  '83': { nom: 'Var',                  bbox: [5.66, 42.98, 7.02, 43.85] },
  '06': { nom: 'Alpes-Maritimes',      bbox: [6.63, 43.48, 7.72, 44.36] },
  '2A': { nom: 'Corse-du-Sud',         bbox: [8.53, 41.33, 9.41, 42.38] },
  '2B': { nom: 'Haute-Corse',          bbox: [8.57, 42.00, 9.56, 43.01] }
};

export default async function handler(req, res) {
  const depart = Date.now();
  const dep = req.query.dep ? req.query.dep.toString().toUpperCase() : null;
  const bboxParam = req.query.bbox ? req.query.bbox.toString() : null;
  const n = Math.max(1, Math.min(10, parseInt(req.query.grille || '5', 10)));

  if (!dep && !bboxParam) {
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      usage: [
        '/api/scan?dep=33            balaye un departement (grille 5x5 par defaut)',
        '/api/scan?dep=85&grille=8   resserre la grille',
        '/api/scan?bbox=lonMin,latMin,lonMax,latMax   emprise libre'
      ],
      departements_disponibles: Object.entries(DEPARTEMENTS)
        .map(([c, d]) => ({ code: c, nom: d.nom })),
      objet: "Localiser les prescriptions 54-01 et 54-02 (recul du trait de cote, R.125-23 7°) et les cartes de prefiguration."
    });
  }

  let bbox, libelle;
  if (bboxParam) {
    const p = bboxParam.split(',').map(Number);
    if (p.length !== 4 || p.some(isNaN)) {
      return res.status(400).json({ resultat: 'ECHEC', cause: 'bbox attendu : lonMin,latMin,lonMax,latMax' });
    }
    bbox = p; libelle = `emprise libre ${bboxParam}`;
  } else {
    if (!DEPARTEMENTS[dep]) {
      return res.status(400).json({
        resultat: 'ECHEC', cause: `Departement ${dep} absent de la table.`,
        disponibles: Object.keys(DEPARTEMENTS)
      });
    }
    bbox = DEPARTEMENTS[dep].bbox;
    libelle = `${dep} — ${DEPARTEMENTS[dep].nom}`;
  }

  const mailles = decouper(bbox, n);
  const zones = [];
  const prefigurations = [];
  const tronquees = [];
  const codes = new Map();
  let interrogees = 0;
  let erreurs = 0;

  for (const m of mailles) {
    const pres = await couche('prescription-surf', m.polygone);
    interrogees++;

    if (!pres.ok) { erreurs++; continue; }
    if (pres.items.length >= LIMITE) {
      tronquees.push({ maille: m.rang, entites: pres.items.length });
    }

    for (const p of pres.items) {
      const code = `${pad(p.typepsc)}-${pad(p.stypepsc)}`;
      codes.set(code, (codes.get(code) || 0) + 1);
      if (CODES_CIBLE.includes(code)) {
        zones.push({
          maille: m.rang, code,
          libelle: p.libelle || null,
          etiquette: p.txt || null,
          nature: p.nature || null,
          idurba: p.idurba || null,
          partition: p.partition || null,
          fichier: p.nomfic || null,
          lien: p.urlfic || null
        });
      }
    }
    await pause(150);
  }

  // Cartes de prefiguration : seulement si aucune zone trouvee, pour limiter
  // le nombre d'appels. Elles sont subsidiaires par construction.
  if (!zones.length) {
    for (const m of mailles) {
      const infos = await couche('info-surf', m.polygone);
      if (!infos.ok) continue;
      for (const i of infos.items) {
        const txt = (i.txt || '').toLowerCase();
        const lib = normaliser(i.libelle || '');
        if (txt.includes('pre-zertc') || lib.includes('prefiguration')) {
          prefigurations.push({
            maille: m.rang,
            code: `${pad(i.typeinf)}-${pad(i.stypeinf)}`,
            libelle: i.libelle || null,
            etiquette: i.txt || null,
            partition: i.partition || null,
            avertissement: 'reconnaissance par libelle, non par code'
          });
        }
      }
      await pause(150);
    }
  }

  const partitions = new Set([
    ...zones.map(z => z.partition).filter(Boolean),
    ...prefigurations.map(p => p.partition).filter(Boolean)
  ]);

  return res.status(200).json({
    horodatage: new Date().toISOString(),
    emprise: { libelle, bbox, grille: `${n}x${n}`, mailles: mailles.length },
    synthese: {
      mailles_interrogees: interrogees,
      erreurs,
      zones_trait_de_cote: zones.length,
      cartes_prefiguration: prefigurations.length,
      duree_totale_ms: Date.now() - depart
    },
    fiabilite: tronquees.length
      ? { etat: 'INCOMPLET', mailles_tronquees: tronquees,
          remede: `Au moins une maille atteint la limite de ${LIMITE} entites : des resultats sont perdus. Resserrer avec &grille=${Math.min(10, n + 3)}.` }
      : { etat: 'COMPLET', commentaire: `Aucune maille n'atteint la limite de ${LIMITE} entites.` },
    zones_trait_de_cote: zones,
    cartes_prefiguration: prefigurations,
    documents_concernes: Array.from(partitions),
    codes_prescription_observes: Array.from(codes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([code, n2]) => ({ code, occurrences: n2 })),
    suite: zones.length || prefigurations.length
      ? "Zones localisees. Identifier une parcelle dans l'une d'elles, puis /api/gpu?parcelle=... pour eprouver la qualification dans son cas positif."
      : "Aucune zone sur cette emprise. Essayer un autre departement : /api/scan pour la liste."
  });
}

// ---------------------------------------------------------------------------
function decouper([x1, y1, x2, y2], n) {
  const dx = (x2 - x1) / n;
  const dy = (y2 - y1) / n;
  const out = [];
  let rang = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      rang++;
      const a = x1 + i * dx, b = y1 + j * dy;
      const c = a + dx, d = b + dy;
      out.push({
        rang,
        polygone: { type: 'Polygon',
          coordinates: [[[a, b], [c, b], [c, d], [a, d], [a, b]]] }
      });
    }
  }
  return out;
}

async function couche(nom, geometrie) {
  const params = new URLSearchParams();
  params.set('geom', JSON.stringify(geometrie));
  params.set('_limit', String(LIMITE));
  try {
    const r = await fetch(`${IGN_GPU}/${nom}?${params.toString()}`,
                          { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return { ok: false, cause: `HTTP ${r.status}` };
    const j = JSON.parse(await r.text());
    const t = Array.isArray(j.features) ? j.features : [];
    return { ok: true, items: t.map(f => f.properties || {}) };
  } catch (e) {
    return { ok: false, cause: e.message };
  }
}

function normaliser(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-\s]+/g, '');
}

function pad(v) {
  if (v === null || v === undefined || v === '') return '00';
  const s = String(v);
  return s.length === 1 ? '0' + s : s;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
