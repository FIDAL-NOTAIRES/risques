// RISQUES — /api/zone.mjs
//
// Eprouver zoneRegExists dans son cas POSITIF, a l'echelle du bien.
//
// CE QUE LE TEST PRECEDENT A ETABLI
// Le champ zonageReglementaire.zoneRegExists n'est pas une propriete du plan :
// il est evalue par rapport a la GEOMETRIE INTERROGEE. Sur Villeneuve-d'Ascq,
// les deux memes procedures repondent faux par parcelle et vrai par code INSEE.
//
// Par commune, la question posee est "une zone delimitee existe-t-elle sur ce
// territoire". Par parcelle ou par point, "une zone couvre-t-elle ce bien".
// Seule la seconde est celle de R.125-23. La qualification ne doit donc JAMAIS
// se faire par code INSEE : les huit communes testees ressortaient positives,
// ce qui aurait declare concernes tous les biens de Tours, Blois, Orleans,
// Nimes, Aix, Bordeaux et Rouen.
//
// OBJET DE CET ENDPOINT
// Trouver un point effectivement situe en zone delimitee, pour verifier ce que
// l'API restitue alors : listTypeReg doit porter la SEULE zone applicable au
// point, et non toutes les zones du plan.
//
// METHODE
// Points de reference choisis a proximite immediate d'un cours d'eau dans des
// communes dont le PPR comporte des zones delimitees, etablies par le test
// precedent. Coordonnees approximatives, saisies pour balayer une zone
// inondable plausible : elles sont a eprouver, non a croire.
//
// Usage :
//   /api/zone
//   /api/zone?latlon=0.6848,47.3900
//   /api/zone?latlon=0.6848,47.3900&rayon=200

const BASE = 'https://www.georisques.gouv.fr';
const FAMILLES = ['pprn', 'pprt', 'pprm'];

// Longitude, latitude. Bords de Loire, du Cher, de la Seine, du Vistre.
const POINTS = [
  { lon: 0.6848, lat: 47.3900, note: 'Tours, bord de Loire pres du pont Wilson' },
  { lon: 0.6900, lat: 47.3830, note: 'Tours, bord du Cher' },
  { lon: 1.3320, lat: 47.5860, note: 'Blois, bord de Loire rive droite' },
  { lon: 1.3300, lat: 47.5820, note: 'Blois, rive gauche (Vienne)' },
  { lon: 1.9040, lat: 47.8980, note: "Orleans, bord de Loire" },
  { lon: 1.0740, lat: 49.4380, note: 'Rouen, bord de Seine' },
  { lon: 4.3600, lat: 43.8280, note: 'Nimes, secteur du Vistre' },
  { lon: 5.4470, lat: 43.5150, note: "Aix-en-Provence, bord de l'Arc" }
];

export default async function handler(req, res) {
  const debut = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;
  const rayon = req.query.rayon ? String(parseInt(req.query.rayon, 10)) : null;

  if (!jeton) {
    return res.status(500).json({
      resultat: 'ECHEC',
      cause: "Variable d'environnement GEORISQUES_TOKEN absente."
    });
  }

  let liste = POINTS;
  if (req.query.latlon) {
    const p = req.query.latlon.toString().split(',').map(Number);
    if (p.length !== 2 || p.some(isNaN)) {
      return res.status(400).json({
        resultat: 'ECHEC',
        cause: 'latlon attendu : longitude,latitude (separateur decimal : le point)'
      });
    }
    liste = [{ lon: p[0], lat: p[1], note: 'fourni en parametre' }];
  }

  const resultats = [];
  for (const pt of liste) {
    resultats.push(await examiner(pt, jeton, rayon));
    await pause(130);
  }

  const positifs = resultats.filter(r => r.qualification && r.qualification.retenu);

  return res.status(200).json({
    horodatage: new Date().toISOString(),
    objet: "Eprouver zoneRegExists dans son cas positif a l'echelle du bien",
    avertissement_methode: {
      interrogation: rayon ? `point + rayon de ${rayon} m` : 'point strict',
      regle: "Ne JAMAIS qualifier par codesInsee : le champ zoneRegExists y repond a l'echelle communale et produit un faux positif de masse.",
      coordonnees: "Points de reference approximatifs, choisis pour balayer une zone inondable plausible. A eprouver, non a croire."
    },
    synthese: {
      points_testes: resultats.length,
      en_zone_delimitee: positifs.length,
      duree_totale_ms: Date.now() - debut
    },
    cas_positifs: positifs.map(p => ({
      point: p.point,
      note: p.note,
      plans: p.zones_delimitees
    })),
    lecture: positifs.length
      ? "Cas positif obtenu a l'echelle du bien. Verifier dans listTypeReg si l'API restitue la SEULE zone applicable au point, ou toutes les zones du plan : la reponse determine si l'extrait de document graphique exige par R.125-24 est directement deductible."
      : "Aucun point en zone delimitee. Les coordonnees sont approximatives : essayer d'autres points avec ?latlon=lon,lat, ou ajouter &rayon=200 pour elargir.",
    detail: resultats
  });
}

async function examiner(pt, jeton, rayon) {
  const out = {
    point: `${pt.lon},${pt.lat}`,
    note: pt.note,
    familles: {},
    zones_delimitees: []
  };

  for (const f of FAMILLES) {
    const criteres = { longitude: String(pt.lon), latitude: String(pt.lat) };
    if (rayon) criteres.rayon = rayon;

    const r = await interroger(f, criteres, jeton);
    out.familles[f] = {
      code_http: r.code_http,
      total: r.total ?? 0,
      procedures: (r.items || []).map(e => ({
        idGaspar: e.idGaspar,
        libelle: e.libPpr,
        en_zone: e.zonageReglementaire ? e.zonageReglementaire.zoneRegExists : null,
        nb_zones: ((e.zonageReglementaire || {}).listTypeReg || []).length
      }))
    };
    if (r.erreur) out.familles[f].erreur = r.erreur;

    for (const e of (r.items || [])) {
      const z = e.zonageReglementaire;
      if (z && z.zoneRegExists === true) {
        out.zones_delimitees.push({
          famille: f,
          idGaspar: e.idGaspar || null,
          libelle: e.libPpr || null,
          modele: e.modeleProcedure || null,
          en_revision: e.etatRevision,
          nombre_de_zones_restituees: (z.listTypeReg || []).length,
          zones: (z.listTypeReg || []).map(t => ({
            code: t.code || null,
            codeZone: t.codeZone || null,
            libelle: t.libelle || null,
            nom: t.nom || null
          })),
          documents: `/api/v2/gaspar/${f}/${e.idGaspar}/documents`
        });
      }
    }
    await pause(110);
  }

  const total = FAMILLES.reduce((a, f) => a + (out.familles[f].total || 0), 0);

  if (!total) {
    out.qualification = { retenu: false, motif: 'aucune procedure de PPR sur ce point' };
  } else if (!out.zones_delimitees.length) {
    out.qualification = {
      retenu: false,
      motif: `${total} procedure(s) sur le territoire, mais aucune zone delimitee couvrant ce point`,
      lecture: "Ne figure PAS au corps de l'etat des risques."
    };
  } else {
    // Une seule zone restituee : c'est vraisemblablement celle applicable au
    // point. Plusieurs : l'API restitue le zonage du plan, et la zone du bien
    // reste a determiner autrement.
    const uneSeule = out.zones_delimitees.every(z => z.nombre_de_zones_restituees === 1);
    out.qualification = {
      retenu: true,
      motif: `${out.zones_delimitees.length} plan(s) avec zone delimitee couvrant ce point`,
      zonage: uneSeule
        ? "Une seule zone restituee par plan : vraisemblablement celle applicable au point. Directement exploitable pour R.125-24."
        : "Plusieurs zones restituees par plan : l'API renvoie le zonage du plan, non la zone du bien. L'extrait de document graphique devra etre determine autrement.",
      exigences_R125_24: [
        'extrait du document graphique situant le bien par rapport au zonage',
        'extrait du reglement le concernant',
        'information sur les travaux prescrits et leur realisation (declaratif)'
      ]
    };
  }

  return out;
}

async function interroger(famille, criteres, jeton) {
  const params = new URLSearchParams(criteres);
  params.set('pageNumber', '0');
  params.set('pageSize', '100');
  const url = `${BASE}/api/v2/gaspar/${famille}?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' }
    });
    const txt = await r.text();
    if (r.status !== 200) {
      return { code_http: r.status, items: [], erreur: txt.slice(0, 200) };
    }
    const j = JSON.parse(txt);
    return {
      code_http: 200,
      total: j.totalElements,
      items: Array.isArray(j.content) ? j.content : []
    };
  } catch (e) {
    return { code_http: 0, items: [], erreur: e.message };
  }
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
