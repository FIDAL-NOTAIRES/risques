// RISQUES — /api/sonde.mjs
//
// FICHIER DE MISE AU POINT, JETABLE. Il ne produit aucun document : il sert
// uniquement a identifier les points d'entree des quatre rubriques restees
// muettes au premier essai reel du 22/09/2026 (SIS, remontee de nappe,
// canalisations de matieres dangereuses, TRI), ainsi que les noms reels des
// couches cartographiques que je n'avais pas pu sonder.
//
// A SUPPRIMER du depot une fois les chemins figes dans lib/moisson.mjs.
//
// Il procede en trois temps :
//
//   1. DOCUMENTATION. Il tente de recuperer la description OpenAPI de
//      l'interface. Si elle repond, la liste des chemins publies est
//      exhaustive et tranche la question sans autre essai.
//
//   2. ESSAIS CROISES. Pour chaque rubrique muette, il essaie chaque chemin
//      candidat avec chaque forme de parametre (reference cadastrale, code
//      INSEE, couple de coordonnees) et restitue le code HTTP de chacun.
//      La distinction est decisive : 404 = le chemin n'existe pas ;
//      400 ou 422 = le chemin existe mais le parametre est mal forme ;
//      401 ou 403 = le jeton ne couvre pas cette base ; 200 = trouve.
//
//   3. COUCHES CARTOGRAPHIQUES. Il interroge les capacites du service WMS
//      et restitue les noms de couches contenant les mots-cles utiles. Cela
//      remplace les sept noms que j'avais ecrits sans pouvoir les verifier.
//
// Usage :
//   /api/sonde                                   parcelle de Boulogne par defaut
//   /api/sonde?parcelle=62160-000-XM-0307
//   /api/sonde?caps=brgm                         couches BRGM seules (defaut)
//   /api/sonde?caps=brgm,ign                     ajoute les couches IGN
//   /api/sonde?caps=0                            sans sondage cartographique

const GEO = 'https://www.georisques.gouv.fr';
const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';

const SERVICES_WMS = {
  brgm: 'https://mapsref.brgm.fr/wxs/georisques/risques',
  ign: 'https://data.geopf.fr/wms-r'
};

// Mots-cles cherches dans les noms de couches renvoyes par le service.
const MOTS_COUCHES = [
  'nappe', 'remnappe', 'canalisation', 'sis', 'argile', 'alearg', 'rga',
  'radon', 'sismi', 'casias', 'icpe', 'installation', 'ppr', 'tri',
  'submersion', 'debrouss', 'old', 'inond', 'catnat', 'sol'
];

// ---------------------------------------------------------------------------
// 1. Documentation publiee
// ---------------------------------------------------------------------------
const DOCS = [
  `${GEO}/api/v1/swagger.json`,
  `${GEO}/api/v2/swagger.json`,
  `${GEO}/v3/api-docs`,
  `${GEO}/api/v1/api-docs`,
  `${GEO}/api/v2/api-docs`,
  `${GEO}/api-docs`
];

// ---------------------------------------------------------------------------
// 2. Chemins candidats, par rubrique muette
// ---------------------------------------------------------------------------
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

// Trois formes de parametre. Un chemin peut exister et n'accepter qu'une
// seule d'entre elles : l'essai croise le dit sans ambiguite.
const FORMES = {
  parcelle: (c) => ({ codesParcelle: c.parcelle }),
  insee: (c) => ({ code_insee: c.insee }),
  latlon: (c) => ({ latlon: `${c.lon.toFixed(6)},${c.lat.toFixed(6)}`, rayon: '1000' })
};

export default async function handler(req, res) {
  const t0 = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;
  const parcelle = (req.query.parcelle || '62160-000-XM-0307').toString();
  const caps = (req.query.caps ?? 'brgm').toString();

  if (!jeton) {
    return res.status(500).json({ resultat: 'ECHEC', cause: 'GEORISQUES_TOKEN absente.' });
  }

  const sortie = { horodatage: new Date().toISOString(), parcelle };

  try {
    // Geometrie : indispensable pour la forme « latlon ».
    const geo = await geometrie(parcelle);
    if (!geo.obtenu) {
      return res.status(200).json({ resultat: 'ECHEC', cause: geo.cause });
    }
    const ctx = {
      parcelle,
      insee: parcelle.split('-')[0],
      lon: geo.centre.lon,
      lat: geo.centre.lat
    };
    sortie.centre = ctx;

    // --- 1. Documentation -------------------------------------------------
    sortie.documentation = await documentation(jeton);

    // --- 2. Essais croises ------------------------------------------------
    const essais = [];
    for (const [rubrique, liste] of Object.entries(CHEMINS)) {
      for (const [version, chemin] of liste) {
        for (const [forme, fabrique] of Object.entries(FORMES)) {
          essais.push({ rubrique, version, chemin, forme, criteres: fabrique(ctx) });
        }
      }
    }
    sortie.essais = await parLots(essais, 6, (e) => essayer(e, jeton));

    // Resume : ce qui a repondu 200, rubrique par rubrique.
    sortie.retenus = {};
    for (const rubrique of Object.keys(CHEMINS)) {
      const bons = sortie.essais.filter(e => e.rubrique === rubrique && e.code === 200);
      sortie.retenus[rubrique] = bons.length
        ? bons.map(e => `${e.chemin} (${e.forme}) — ${e.elements} élément(s)`)
        : 'aucune combinaison n\'a répondu 200';
    }

    // --- 3. Couches cartographiques ---------------------------------------
    sortie.couches = {};
    if (caps !== '0') {
      for (const nom of caps.split(',').map(s => s.trim()).filter(Boolean)) {
        if (!SERVICES_WMS[nom]) continue;
        sortie.couches[nom] = await couchesDuService(SERVICES_WMS[nom]);
      }
    }

    sortie.duree_ms = Date.now() - t0;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json(sortie);

  } catch (e) {
    return res.status(500).json({
      resultat: 'ECHEC',
      cause: e.message,
      pile: (e.stack || '').split('\n').slice(0, 6),
      duree_ms: Date.now() - t0
    });
  }
}

// ---------------------------------------------------------------------------
async function geometrie(reference) {
  const m = reference.split('-');
  if (m.length !== 4) return { obtenu: false, cause: `Référence non décomposable : ${reference}` };
  const [insee, comAbs, section, numero] = m;
  const url = `${IGN_CADASTRE}?code_insee=${insee}&section=${section}&numero=${numero}&com_abs=${comAbs}&_limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
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

// ---------------------------------------------------------------------------
async function documentation(jeton) {
  const out = [];
  for (const url of DOCS) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' }
      });
      const type = r.headers.get('content-type') || '';
      if (r.status !== 200 || !type.includes('json')) {
        out.push({ url, code: r.status, type: type.slice(0, 40), chemins: null });
        continue;
      }
      const j = await r.json();
      const chemins = j && j.paths ? Object.keys(j.paths) : null;
      out.push({
        url, code: 200,
        titre: j && j.info ? j.info.title : null,
        nombre: chemins ? chemins.length : 0,
        // On ne retient que ce qui touche aux quatre rubriques muettes,
        // sans quoi la reponse serait illisible.
        chemins: chemins
          ? chemins.filter(c => /sis|sol|nappe|canalis|tri|inond|pollu/i.test(c))
          : null,
        tous: chemins
      });
      // Une description complete suffit : inutile d'interroger les suivantes.
      if (chemins && chemins.length) break;
    } catch (e) {
      out.push({ url, code: null, erreur: e.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
async function essayer({ rubrique, version, chemin, forme, criteres }, jeton) {
  const q = new URLSearchParams(criteres);
  if (version === 'v2') { q.set('pageNumber', '0'); q.set('pageSize', '5'); }
  else { q.set('page', '1'); q.set('page_size', '5'); }

  const entetes = { Accept: 'application/json' };
  if (version === 'v2') entetes.Authorization = `Bearer ${jeton}`;

  const base = { rubrique, version, chemin, forme };
  try {
    const r = await fetch(`${GEO}${chemin}?${q}`, { headers: entetes });
    const type = r.headers.get('content-type') || '';
    if (r.status !== 200) {
      // Le corps d'une erreur porte souvent le nom du parametre attendu :
      // c'est l'information la plus utile de tout ce fichier.
      let corps = null;
      try { corps = (await r.text()).slice(0, 300); } catch { /* corps illisible */ }
      return { ...base, code: r.status, type: type.slice(0, 40), corps };
    }
    if (!type.includes('json')) {
      return { ...base, code: 200, type: type.slice(0, 40), avertissement: 'réponse non JSON' };
    }
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

// ---------------------------------------------------------------------------
// Capacites d'un service WMS : on ne retient que les noms de couches, et
// parmi eux ceux qui contiennent un mot-cle utile. Le document complet peut
// peser plusieurs megaoctets et n'a aucun interet ici.
async function couchesDuService(service) {
  const url = `${service}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/xml' } });
    if (r.status !== 200) return { code: r.status, couches: null };
    const xml = await r.text();
    const noms = [...xml.matchAll(/<Name>([^<]{2,120})<\/Name>/g)].map(m => m[1]);
    const uniques = [...new Set(noms)];
    return {
      code: 200,
      total: uniques.length,
      retenues: uniques.filter(n => MOTS_COUCHES.some(k => n.toLowerCase().includes(k))).slice(0, 120)
    };
  } catch (e) {
    return { code: null, erreur: e.message };
  }
}

// ---------------------------------------------------------------------------
// Lots de taille bornee : une centaine d'appels simultanes se ferait
// etrangler par la source, ce qui produirait de faux « ne repond pas ».
async function parLots(elements, taille, traitement) {
  const out = [];
  for (let i = 0; i < elements.length; i += taille) {
    const lot = elements.slice(i, i + taille);
    out.push(...await Promise.all(lot.map(traitement)));
  }
  return out;
}
