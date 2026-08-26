// RISQUES — /api/scan.mjs
//
// Balayage a la recherche des prescriptions 54-01 et 54-02 (zones exposees au
// recul du trait de cote, R.125-23 7°) et des cartes de prefiguration.
//
// CORRECTION APPORTEE A LA VERSION PRECEDENTE
// La limite de restitution etait fixee a 1000 dans le code, alors que l'API en
// renvoie 5000 : c'est son propre plafond, que le parametre _limit ne releve
// pas. La detection de troncature fonctionnait donc par accident. Constante
// corrigee a 5000.
//
// SUBDIVISION ADAPTATIVE
// Sur la Vendee, treize mailles sur vingt-cinq saturaient. Un resultat obtenu
// sur une maille saturee ne prouve RIEN : les entites perdues peuvent contenir
// precisement ce que l'on cherche. Une grille fixe ne peut donc pas garantir
// l'exhaustivite.
//
// Chaque maille saturee est desormais redecoupee en quatre, recursivement,
// jusqu'a ce qu'aucune ne sature ou que la profondeur maximale soit atteinte.
// Toute maille encore saturee a la profondeur maximale est nommement signalee :
// le resultat est alors declare INCOMPLET, et l'absence de zone n'y vaut pas
// preuve d'absence.
//
// Un resultat n'est concluant que si l'etat est COMPLET.
//
// Usage :
//   /api/scan?dep=85
//   /api/scan?dep=85&profondeur=4      (plus fin, plus long)
//   /api/scan?bbox=-2.4,46.2,-1.7,46.6
//   /api/scan                          -> liste des departements

const IGN_GPU = 'https://apicarto.ign.fr/api/gpu';

// Plafond reel de l'API, constate par appel : 5000 entites par requete.
const PLAFOND = 5000;

// Garde-fous : au-dela, la fonction serverless expirerait.
const MAX_APPELS = 220;
const PROFONDEUR_DEFAUT = 3;   // 1 maille -> jusqu'a 4^3 = 64 sous-mailles
const PROFONDEUR_MAX = 5;

const CODES_CIBLE = ['54-01', '54-02'];

const DEPARTEMENTS = {
  '62': { nom: 'Pas-de-Calais',        bbox: [1.55, 50.02, 3.19, 51.01] },
  '80': { nom: 'Somme',                bbox: [1.37, 49.57, 3.19, 50.37] },
  '76': { nom: 'Seine-Maritime',       bbox: [0.06, 49.24, 1.79, 50.07] },
  '14': { nom: 'Calvados',             bbox: [-1.15, 48.75, 0.45, 49.44] },
  '50': { nom: 'Manche',               bbox: [-1.95, 48.44, -0.75, 49.73] },
  '35': { nom: 'Ille-et-Vilaine',      bbox: [-2.29, 47.63, -1.35, 48.70] },
  '22': { nom: "Cotes-d'Armor",        bbox: [-3.65, 48.03, -1.95, 48.90] },
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
  const debut = Date.now();
  const dep = req.query.dep ? req.query.dep.toString().toUpperCase() : null;
  const bboxParam = req.query.bbox ? req.query.bbox.toString() : null;
  const profondeurMax = Math.max(1, Math.min(PROFONDEUR_MAX,
    parseInt(req.query.profondeur || String(PROFONDEUR_DEFAUT), 10)));

  if (!dep && !bboxParam) {
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      usage: [
        '/api/scan?dep=85                balaye un departement, subdivision adaptative',
        '/api/scan?dep=85&profondeur=4   plus fin, plus long',
        '/api/scan?bbox=lonMin,latMin,lonMax,latMax'
      ],
      methode: {
        plafond_api: PLAFOND,
        principe: "Toute maille atteignant le plafond est redecoupee en quatre, recursivement.",
        lecture: "Un resultat n'est concluant que si fiabilite.etat vaut COMPLET."
      },
      departements_disponibles: Object.entries(DEPARTEMENTS)
        .map(([c, d]) => ({ code: c, nom: d.nom }))
    });
  }

  let bbox, libelle;
  if (bboxParam) {
    const p = bboxParam.split(',').map(Number);
    if (p.length !== 4 || p.some(isNaN)) {
      return res.status(400).json({ resultat: 'ECHEC', cause: 'bbox attendu : lonMin,latMin,lonMax,latMax' });
    }
    bbox = p; libelle = `emprise libre ${bboxParam}`;
  } else if (DEPARTEMENTS[dep]) {
    bbox = DEPARTEMENTS[dep].bbox;
    libelle = `${dep} — ${DEPARTEMENTS[dep].nom}`;
  } else {
    return res.status(400).json({
      resultat: 'ECHEC', cause: `Departement ${dep} absent de la table.`,
      disponibles: Object.keys(DEPARTEMENTS)
    });
  }

  const etat = {
    appels: 0,
    plafond_atteint: false,
    zones: [],
    saturees: [],
    codes: new Map(),
    erreurs: []
  };

  // Amorce : grille 3x3, puis subdivision adaptative de chaque maille saturee.
  const amorce = decouper(bbox, 3);
  for (const m of amorce) {
    await explorer(m, 1, profondeurMax, etat);
    if (etat.appels >= MAX_APPELS) { etat.plafond_atteint = true; break; }
  }

  // Cartes de prefiguration : recherchees seulement si aucune zone trouvee.
  const prefigurations = [];
  if (!etat.zones.length && etat.appels < MAX_APPELS) {
    for (const m of amorce) {
      if (etat.appels >= MAX_APPELS) break;
      const r = await couche('info-surf', m);
      etat.appels++;
      if (!r.ok) continue;
      for (const i of r.items) {
        const txt = (i.txt || '').toLowerCase();
        const lib = normaliser(i.libelle || '');
        if (txt.includes('pre-zertc') || lib.includes('prefiguration')) {
          prefigurations.push({
            code: `${pad(i.typeinf)}-${pad(i.stypeinf)}`,
            libelle: i.libelle || null, etiquette: i.txt || null,
            partition: i.partition || null,
            avertissement: 'reconnaissance par libelle, non par code'
          });
        }
      }
      await pause(120);
    }
  }

  const complet = etat.saturees.length === 0 && !etat.plafond_atteint;
  const partitions = new Set([
    ...etat.zones.map(z => z.partition).filter(Boolean),
    ...prefigurations.map(p => p.partition).filter(Boolean)
  ]);

  return res.status(200).json({
    horodatage: new Date().toISOString(),
    emprise: { libelle, bbox, profondeur_max: profondeurMax },
    synthese: {
      appels_api: etat.appels,
      zones_trait_de_cote: etat.zones.length,
      cartes_prefiguration: prefigurations.length,
      erreurs: etat.erreurs.length,
      duree_totale_ms: Date.now() - debut
    },
    fiabilite: complet
      ? { etat: 'COMPLET',
          commentaire: `Aucune maille n'atteint le plafond de ${PLAFOND} entites. L'absence de zone vaut donc absence sur cette emprise.` }
      : { etat: 'INCOMPLET',
          mailles_saturees: etat.saturees.slice(0, 20),
          budget_epuise: etat.plafond_atteint,
          avertissement: "Des entites n'ont pas ete restituees. L'absence de zone ne vaut PAS absence : elle peut se trouver dans les entites perdues.",
          remede: etat.plafond_atteint
            ? `Budget de ${MAX_APPELS} appels epuise. Restreindre l'emprise avec &bbox= plutot que le departement entier.`
            : `Augmenter la finesse : &profondeur=${Math.min(PROFONDEUR_MAX, profondeurMax + 1)}` },
    zones_trait_de_cote: etat.zones,
    cartes_prefiguration: prefigurations,
    documents_concernes: Array.from(partitions),
    codes_prescription_observes: Array.from(etat.codes.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => ({ code, occurrences: n })),
    suite: etat.zones.length || prefigurations.length
      ? "Zones localisees. Relever une parcelle dans l'une d'elles, puis /api/gpu?parcelle=... pour eprouver la qualification dans son cas positif."
      : complet
        ? "Aucune zone sur cette emprise, resultat concluant. Essayer un autre departement."
        : "Aucune zone trouvee, mais resultat NON concluant : voir fiabilite."
  });
}

// ---------------------------------------------------------------------------
// Explore une maille ; si elle sature, la redecoupe en quatre et recommence.
// ---------------------------------------------------------------------------
async function explorer(maille, profondeur, profondeurMax, etat) {
  if (etat.appels >= MAX_APPELS) { etat.plafond_atteint = true; return; }

  const r = await couche('prescription-surf', maille);
  etat.appels++;
  await pause(110);

  if (!r.ok) {
    etat.erreurs.push({ bbox: maille.bbox, cause: r.cause });
    return;
  }

  const sature = r.items.length >= PLAFOND;

  if (sature && profondeur < profondeurMax) {
    // On ne retient rien de cette maille : ses resultats sont incomplets.
    // On la redecoupe et on repart de zero sur chaque quart.
    for (const q of decouperMaille(maille, 2)) {
      await explorer(q, profondeur + 1, profondeurMax, etat);
      if (etat.appels >= MAX_APPELS) { etat.plafond_atteint = true; return; }
    }
    return;
  }

  if (sature) {
    etat.saturees.push({ bbox: maille.bbox.map(v => Number(v.toFixed(4))), profondeur });
  }

  for (const p of r.items) {
    const code = `${pad(p.typepsc)}-${pad(p.stypepsc)}`;
    etat.codes.set(code, (etat.codes.get(code) || 0) + 1);
    if (CODES_CIBLE.includes(code)) {
      etat.zones.push({
        code,
        libelle: p.libelle || null,
        etiquette: p.txt || null,
        nature: p.nature || null,
        idurba: p.idurba || null,
        partition: p.partition || null,
        fichier: p.nomfic || null,
        lien: p.urlfic || null,
        bbox_maille: maille.bbox.map(v => Number(v.toFixed(4)))
      });
    }
  }
}

// ---------------------------------------------------------------------------
function decouper([x1, y1, x2, y2], n) {
  const dx = (x2 - x1) / n, dy = (y2 - y1) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = x1 + i * dx, b = y1 + j * dy;
      out.push(fabriquer([a, b, a + dx, b + dy]));
    }
  }
  return out;
}

function decouperMaille(m, n) {
  return decouper(m.bbox, n);
}

function fabriquer([a, b, c, d]) {
  return {
    bbox: [a, b, c, d],
    polygone: { type: 'Polygon', coordinates: [[[a, b], [c, b], [c, d], [a, d], [a, b]]] }
  };
}

async function couche(nom, maille) {
  const params = new URLSearchParams();
  params.set('geom', JSON.stringify(maille.polygone));
  params.set('_limit', String(PLAFOND));
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
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[_\-\s]+/g, '');
}

function pad(v) {
  if (v === null || v === undefined || v === '') return '00';
  const s = String(v);
  return s.length === 1 ? '0' + s : s;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
