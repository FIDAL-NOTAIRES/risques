// RISQUES — /api/sonde.mjs
//
// FICHIER DE MISE AU POINT, JETABLE. Il ne produit aucun document : il sert
// uniquement a identifier les points d'entree des quatre rubriques restees
// muettes au premier essai reel du 22/09/2026 (SIS, remontee de nappe,
// canalisations de matieres dangereuses, TRI), ainsi que les noms reels des
// couches cartographiques.
//
// A SUPPRIMER du depot une fois les chemins figes dans lib/moisson.mjs.
//
// VERSION DECOUPEE (02/10/2026) : la premiere version faisait tout en un seul
// appel et depassait les 60 s autorisees (erreur 504). Le travail est
// desormais reparti en etapes courtes, une par adresse, et chaque appel
// sortant est borne a 8 s.
//
// Usage, dans cet ordre :
//   /api/sonde                              sommaire des etapes (liens)
//   /api/sonde?etape=doc                    documentation publiee (v2 puis v1)
//   /api/sonde?etape=essais&rubrique=sis    essais croises d'une rubrique
//        rubrique = sis | nappe | canalisations | tri
//   /api/sonde?etape=couches&service=brgm   noms de couches du service BRGM
//        service = brgm | ign
//   Parametre facultatif partout : &parcelle=62160-000-XM-0307

const GEO = 'https://www.georisques.gouv.fr';
const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const PARCELLE_DEFAUT = '62160-000-XM-0307';
const DELAI_MS = 8000;

const SERVICES_WMS = {
  brgm: 'https://mapsref.brgm.fr/wxs/georisques/risques',
  ign: 'https://data.geopf.fr/wms-r'
};

const MOTS_COUCHES = [
  'nappe', 'remnappe', 'canalisation', 'sis', 'argile', 'alearg', 'rga',
  'radon', 'sismi', 'casias', 'icpe', 'installation', 'ppr', 'tri',
  'submersion', 'debrouss', 'old', 'inond', 'catnat', 'sol'
];

// Adresses de la documentation : les deux premieres sont celles relevees
// dans l'ancien fichier api/test.mjs ; les autres en secours.
const DOCS = [
  `${GEO}/api/v3/api-docs/georisques-api-v2`,
  `${GEO}/api/v3/api-docs/georisques-api-v1`,
  `${GEO}/api/v2/swagger.json`,
  `${GEO}/api/v1/swagger.json`
];

const FILTRE_DOC = /sis|sol|nappe|canalis|tri|inond|pollu|ssp/i;

const CHEMINS = {
  sis: [
    ['v2', '/api/v2/sis'],
    ['v2', '/api/v2/ssp/sis'],
    ['v2', '/api/v2/secteurs_information_sols'],
    ['v1', '/api/v1/sis'],
    ['v1', '/api/v1/ssp/sis']
  ],
  nappe: [
    ['v2', '/api/v2/remontee_nappe'],
    ['v2', '/api/v2/remontees_nappe'],
    ['v2', '/api/v2/remontees_nappes'],
    ['v2', '/api/v2/nappe'],
    ['v1', '/api/v1/remontee_nappe']
  ],
  canalisations: [
    ['v2', '/api/v2/canalisations_mat_dangereuses'],
    ['v2', '/api/v2/canalisations'],
    ['v2', '/api/v2/gaspar/canalisations'],
    ['v1', '/api/v1/canalisations'],
    ['v1', '/api/v1/canalisations_mat_dangereuses']
  ],
  tri: [
    ['v2', '/api/v2/tri_zonage'],
    ['v2', '/api/v2/tri'],
    ['v2', '/api/v2/tri_zonage_inondable'],
    ['v2', '/api/v2/gaspar/tri'],
    ['v1', '/api/v1/tri'],
    ['v1', '/api/v1/gaspar/tri']
  ]
};

const FORMES = {
  parcelle: (c) => ({ codesParcelle: c.parcelle }),
  insee: (c) => ({ code_insee: c.insee }),
  latlon: (c) => ({ latlon: `${c.lon.toFixed(6)},${c.lat.toFixed(6)}`, rayon: '1000' })
};

export default async function handler(req, res) {
  const t0 = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;
  const q = req.query || {};
  const etape = (q.etape || '').toString();
  const parcelle = (q.parcelle || PARCELLE_DEFAUT).toString();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!jeton) {
    return res.status(500).json({ resultat: 'ECHEC', cause: 'GEORISQUES_TOKEN absente.' });
  }

  try {
    let sortie;
    if (etape === 'doc') {
      sortie = { etape, documentation: await documentation(jeton) };
    } else if (etape === 'essais') {
      const rubrique = (q.rubrique || '').toString();
      if (!CHEMINS[rubrique]) {
        return res.status(400).json({ resultat: 'ECHEC', cause: `rubrique inconnue : ${rubrique}`, possibles: Object.keys(CHEMINS) });
      }
      const geo = await geometrie(parcelle);
      if (!geo.obtenu) return res.status(200).json({ resultat: 'ECHEC', cause: geo.cause });
      const ctx = { parcelle, insee: parcelle.split('-')[0], lon: geo.centre.lon, lat: geo.centre.lat };
      const essais = [];
      for (const [version, chemin] of CHEMINS[rubrique]) {
        for (const [forme, fabrique] of Object.entries(FORMES)) {
          essais.push({ rubrique, version, chemin, forme, criteres: fabrique(ctx) });
        }
      }
      const resultats = await parLots(essais, 6, (e) => essayer(e, jeton));
      const bons = resultats.filter(e => e.code === 200);
      sortie = {
        etape, rubrique, centre: ctx,
        retenus: bons.length
          ? bons.map(e => `${e.chemin} (${e.forme}) — ${e.elements} élément(s)`)
          : 'aucune combinaison n\'a répondu 200',
        essais: resultats
      };
    } else if (etape === 'couches') {
      const service = (q.service || 'brgm').toString();
      if (!SERVICES_WMS[service]) {
        return res.status(400).json({ resultat: 'ECHEC', cause: `service inconnu : ${service}`, possibles: Object.keys(SERVICES_WMS) });
      }
      sortie = { etape, service, couches: await couchesDuService(SERVICES_WMS[service]) };
    } else {
      const base = 'https://risques.vercel.app/api/sonde';
      sortie = {
        sommaire: 'Ouvrir chaque adresse l\'une après l\'autre et coller les résultats.',
        etapes: [
          `${base}?etape=doc`,
          ...Object.keys(CHEMINS).map(r => `${base}?etape=essais&rubrique=${r}`),
          `${base}?etape=couches&service=brgm`,
          `${base}?etape=couches&service=ign`
        ]
      };
    }
    sortie.parcelle = parcelle;
    sortie.duree_ms = Date.now() - t0;
    return res.status(200).json(sortie);
  } catch (e) {
    return res.status(500).json({
      resultat: 'ECHEC', cause: e.message,
      pile: (e.stack || '').split('\n').slice(0, 6),
      duree_ms: Date.now() - t0
    });
  }
}

// Appel sortant borne dans le temps : une source lente ne doit plus faire
// tomber toute la fonction.
async function appel(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(DELAI_MS) });
}

async function geometrie(reference) {
  const m = reference.split('-');
  if (m.length !== 4) return { obtenu: false, cause: `Référence non décomposable : ${reference}` };
  const [insee, comAbs, section, numero] = m;
  const url = `${IGN_CADASTRE}?code_insee=${insee}&section=${section}&numero=${numero}&com_abs=${comAbs}&_limit=1`;
  try {
    const r = await appel(url, { headers: { Accept: 'application/json' } });
    const j = await r.json();
    const t = j.features || [];
    if (!t.length) return { obtenu: false, cause: 'Parcelle introuvable au cadastre IGN.' };
    const pts = [];
    const parcourir = (x) => {
      if (!Array.isArray(x) || typeof x[0] === 'number') return;
      if (Array.isArray(x[0]) && typeof x[0][0] === 'number') { pts.push(...x); return; }
      x.forEach(parcourir);
    };
    parcourir(t[0].geometry.coordinates);
    return {
      obtenu: true,
      centre: {
        lon: pts.reduce((a, p) => a + p[0], 0) / pts.length,
        lat: pts.reduce((a, p) => a + p[1], 0) / pts.length
      }
    };
  } catch (err) {
    return { obtenu: false, cause: err.message };
  }
}

// Les adresses sont interrogees en parallele : quatre appels de 8 s au plus
// tiennent largement dans le delai. On ne renvoie que les chemins utiles,
// la liste complete etant illisible.
async function documentation(jeton) {
  return Promise.all(DOCS.map(async (url) => {
    try {
      const r = await appel(url, { headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' } });
      const type = r.headers.get('content-type') || '';
      if (r.status !== 200 || !type.includes('json')) {
        return { url, code: r.status, type: type.slice(0, 40) };
      }
      const j = await r.json();
      const paths = j && j.paths ? j.paths : {};
      const chemins = Object.keys(paths);
      const utiles = chemins.filter(c => FILTRE_DOC.test(c)).map(c => {
        const op = paths[c].get || {};
        return {
          chemin: c,
          parametres: (op.parameters || []).map(p => `${p.name}${p.required ? ' (obligatoire)' : ''}`)
        };
      });
      return { url, code: 200, titre: j.info ? j.info.title : null, nombre: chemins.length, utiles };
    } catch (e) {
      return { url, code: null, erreur: e.message };
    }
  }));
}

async function essayer({ rubrique, version, chemin, forme, criteres }, jeton) {
  const q = new URLSearchParams(criteres);
  if (version === 'v2') { q.set('pageNumber', '0'); q.set('pageSize', '5'); }
  else { q.set('page', '1'); q.set('page_size', '5'); }
  const entetes = { Accept: 'application/json' };
  if (version === 'v2') entetes.Authorization = `Bearer ${jeton}`;
  const base = { version, chemin, forme };
  try {
    const r = await appel(`${GEO}${chemin}?${q}`, { headers: entetes });
    const type = r.headers.get('content-type') || '';
    if (r.status !== 200) {
      let corps = null;
      try { corps = (await r.text()).slice(0, 300); } catch { /* corps illisible */ }
      return { ...base, code: r.status, corps };
    }
    if (!type.includes('json')) return { ...base, code: 200, avertissement: 'réponse non JSON' };
    const j = await r.json();
    const items = j.content || j.data || j.features || [];
    const premier = items[0] || null;
    return {
      ...base, code: 200,
      elements: j.totalElements ?? j.results ?? items.length,
      champs: premier ? Object.keys(premier).slice(0, 25) : [],
      exemple: premier ? JSON.stringify(premier).slice(0, 500) : null
    };
  } catch (e) {
    return { ...base, code: null, erreur: e.message };
  }
}

// Le catalogue de l'IGN peut peser plusieurs megaoctets : delai porte a 25 s
// pour cette seule etape, qui ne fait qu'un appel.
async function couchesDuService(service) {
  const url = `${service}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/xml' }, signal: AbortSignal.timeout(25000) });
    if (r.status !== 200) return { code: r.status };
    const xml = await r.text();
    const uniques = [...new Set([...xml.matchAll(/<Name>([^<]{2,120})<\/Name>/g)].map(m => m[1]))];
    return {
      code: 200,
      total: uniques.length,
      retenues: uniques.filter(n => MOTS_COUCHES.some(k => n.toLowerCase().includes(k))).slice(0, 120)
    };
  } catch (e) {
    return { code: null, erreur: e.message };
  }
}

async function parLots(elements, taille, traitement) {
  const out = [];
  for (let i = 0; i < elements.length; i += taille) {
    out.push(...await Promise.all(elements.slice(i, i + taille).map(traitement)));
  }
  return out;
}
