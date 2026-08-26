// RISQUES — /api/test.js
//
// Diagnostic + moteur de qualification + geocodage cadastral.
//
// Chemins Georisques : /api/v3/api-docs/georisques-api-v1 et -v2.
// Quotas : v2 20 appels/s ; v1 5 appels/s.
//
// AJOUTS DE CETTE VERSION
//
// 1. GEOCODAGE DE LA PARCELLE via l'API Carto de l'IGN (module cadastre).
//    Sans les coordonnees du bien, aucune distance ne peut etre calculee : ni
//    celle exigee par l'addendum v6, ni la verification du perimetre reel des
//    resultats. Le centroide est calcule depuis la geometrie retournee.
//
// 2. DISTANCE REELLE par formule de haversine, pour chaque entree CASIAS et
//    ICPE. Objet : eprouver l'hypothese expliquant l'ecart avec l'ERRIAL.
//    Sur la parcelle de test, l'API renvoie 40 CASIAS la ou l'ERRIAL en
//    compte 27. Les 13 surnumeraires ont ete identifiees par comparaison des
//    identifiants SSP ; leur statut est heterogene, donc ce n'est pas le
//    filtre. HYPOTHESE A EPROUVER : l'ERRIAL mesure 500 m depuis un POINT,
//    la ou l'API applique le rayon depuis l'EMPRISE de la parcelle, ce qui
//    elargit la zone. Si l'hypothese est juste, les 13 sont au-dela de 500 m
//    du centroide. On mesure, on ne calibre pas.
//
// 3. DIAGNOSTIC DU VOCABULAIRE DES REGIMES ICPE. Le filtre precedent exigeait
//    regime = 'A' ou 'E' et retenait 0 sur 50, alors que l'ERRIAL en compte 1.
//    L'enumeration A/E/AUTRE de la documentation porte sur les PARAMETRES
//    D'ENTREE, non sur les valeurs restituees : la premiere entree affiche
//    "Non ICPE" en clair. Cette version releve donc les valeurs reellement
//    presentes et se contente d'ecarter les "Non ICPE".
//
// Le jeton n'est jamais renvoye au client.
//
// Usage :
//   /api/test
//   /api/test?rubrique=casias
//   /api/test?rayon=500&brut=1

const BASE = 'https://www.georisques.gouv.fr';
const IGN = 'https://apicarto.ign.fr/api/cadastre/parcelle';

const DEFAUTS = {
  insee: '62160',
  parcelle: '62160-000-XM-0307',
  rayon: 500
};

const RUBRIQUES = {
  // --- Corps de l'etat des risques : R.125-23 -----------------------------
  sismique:  { version: 'v2', path: '/api/v2/zonage_sismique', critere: 'parcelle', ial: '5°', seuil: 'zone >= 2' },
  radon:     { version: 'v2', path: '/api/v2/radon', critere: 'parcelle', ial: '6°', seuil: 'classe = 3' },
  old:       { version: 'v2', path: '/api/v2/old', critere: 'parcelle', ial: '8°', seuil: 'presence de zone' },
  pprn:      { version: 'v2', path: '/api/v2/gaspar/pprn', critere: 'parcelle', ial: '2° et 4°', seuil: 'zoneRegExists' },
  pprt:      { version: 'v2', path: '/api/v2/gaspar/pprt', critere: 'parcelle', ial: '1° et 4°', seuil: 'zoneRegExists' },
  pprm:      { version: 'v2', path: '/api/v2/gaspar/pprm', critere: 'parcelle', ial: '3° et 4°', seuil: 'zoneRegExists' },

  // --- Annexe 1 ----------------------------------------------------------
  rga:       { version: 'v2', path: '/api/v2/rga', critere: 'parcelle' },
  casias:    { version: 'v2', path: '/api/v2/ssp/casias', critere: 'parcelle', rayon: true, mesure: 'geom' },
  sis:       { version: 'v2', path: '/api/v2/ssp/conclusions_sis', critere: 'parcelle', rayon: true, mesure: 'geom' },
  sup:       { version: 'v2', path: '/api/v2/ssp/conclusions_sup', critere: 'parcelle', rayon: true, mesure: 'geom' },
  icpe:      { version: 'v2', path: '/api/v2/installations_classees', critere: 'parcelle', rayon: true, mesure: 'latlon', regimes: true },
  mvt:       { version: 'v2', path: '/api/v2/mvt', critere: 'insee', mesure: 'latlon' },
  cavites:   { version: 'v2', path: '/api/v2/cavites', critere: 'insee', mesure: 'latlon' },
  nucleaire: { version: 'v2', path: '/api/v2/installations_nucleaires', critere: 'parcelle' },

  // --- Contexte ----------------------------------------------------------
  tri:       { version: 'v2', path: '/api/v2/gaspar/tri', critere: 'parcelle' },
  azi:       { version: 'v2', path: '/api/v2/gaspar/azi', critere: 'parcelle' },
  papi:      { version: 'v2', path: '/api/v2/gaspar/papi', critere: 'parcelle' },
  dicrim:    { version: 'v2', path: '/api/v2/gaspar/dicrim', critere: 'parcelle' },
  risques:   { version: 'v2', path: '/api/v2/gaspar/risques', critere: 'parcelle' },

  // --- v1 uniquement -----------------------------------------------------
  catnat:    { version: 'v1', path: '/api/v1/gaspar/catnat', critere: 'insee' }
};

export default async function handler(req, res) {
  const depart = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;

  const insee = (req.query.insee || DEFAUTS.insee).toString();
  const parcelle = (req.query.parcelle || DEFAUTS.parcelle).toString();
  const rayon = Number(req.query.rayon || DEFAUTS.rayon);
  const brut = req.query.brut === '1';
  const demandee = req.query.rubrique ? req.query.rubrique.toString() : null;

  const socle = {
    horodatage: new Date().toISOString(),
    jeton: { present: Boolean(jeton), longueur: jeton ? jeton.length : 0 },
    parametres: { insee, parcelle, rayon_metres: rayon, filtres_actifs: !brut }
  };

  if (!jeton) {
    return res.status(500).json({
      ...socle, resultat: 'ECHEC',
      cause: "Variable d'environnement GEORISQUES_TOKEN absente.",
      remede: ['Settings > Environment Variables > GEORISQUES_TOKEN, puis REDEPLOYER.']
    });
  }
  if (demandee && !RUBRIQUES[demandee]) {
    return res.status(400).json({
      ...socle, resultat: 'ECHEC',
      cause: `Rubrique inconnue : ${demandee}`,
      rubriques_disponibles: Object.keys(RUBRIQUES)
    });
  }

  // --- Etape 1 : geocodage cadastral -------------------------------------
  const geo = await geocoder(parcelle);

  const aTester = demandee ? [demandee] : Object.keys(RUBRIQUES);
  const resultats = {};
  for (const nom of aTester) {
    resultats[nom] = await interroger(nom, RUBRIQUES[nom], jeton, insee, parcelle, rayon, brut, geo);
    if (aTester.length > 1) await pause(120);
  }

  const succes = Object.values(resultats).filter(r => r.code_http === 200).length;

  const corps = [];
  const ecartes = [];
  for (const [nom, r] of Object.entries(resultats)) {
    const cfg = RUBRIQUES[nom];
    if (!cfg.ial || r.code_http !== 200 || !r.qualification) continue;
    if (r.qualification.retenu) corps.push({ rubrique: nom, article: cfg.ial, valeur: r.qualification.valeur });
    else ecartes.push({ rubrique: nom, article: cfg.ial, motif: r.qualification.motif });
  }

  return res.status(200).json({
    ...socle,
    resultat: succes === aTester.length ? 'SUCCES' : 'PARTIEL',
    geocodage: geo,
    synthese: {
      testees: aTester.length, en_succes: succes,
      en_echec: aTester.length - succes, duree_totale_ms: Date.now() - depart
    },
    etat_des_risques: {
      corps, ecartes_du_corps: ecartes,
      rappel: "Le 7° (recul du trait de cote) releve du Geoportail de l'urbanisme, non de Georisques."
    },
    rubriques: resultats
  });
}

// ---------------------------------------------------------------------------
// Geocodage : API Carto de l'IGN, module cadastre.
// Format d'entree attendu : INSEE-PREFIXE-SECTION-NUMERO (62160-000-XM-0307).
// ---------------------------------------------------------------------------
async function geocoder(reference) {
  const morceaux = reference.split('-');
  if (morceaux.length !== 4) {
    return { obtenu: false, cause: `Reference non decomposable : ${reference}` };
  }
  const [codeInsee, comAbs, section, numero] = morceaux;

  // Le numero est essaye tel quel puis sans zeros de tete : les conventions
  // divergent entre Georisques (0307) et l'API Carto (307).
  const variantes = [numero, numero.replace(/^0+/, '')];
  const tentatives = [];

  for (const num of variantes) {
    const url = `${IGN}?code_insee=${codeInsee}&section=${section}&numero=${num}&com_abs=${comAbs}&_limit=1`;
    try {
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch { /* ignore */ }

      const traits = j && Array.isArray(j.features) ? j.features : [];
      tentatives.push({ numero_essaye: num, code_http: r.status, features: traits.length });

      if (traits.length) {
        const c = centroide(traits[0].geometry);
        return {
          obtenu: true,
          source: 'API Carto IGN - cadastre',
          numero_retenu: num,
          centroide: c ? { longitude: c[0], latitude: c[1] } : null,
          contenance: traits[0].properties ? traits[0].properties.contenance : null,
          tentatives
        };
      }
    } catch (e) {
      tentatives.push({ numero_essaye: num, erreur: e.message });
    }
  }
  return {
    obtenu: false,
    cause: 'Parcelle introuvable dans le cadastre IGN.',
    consequence: 'Les distances ne peuvent pas etre calculees.',
    tentatives
  };
}

function centroide(geom) {
  if (!geom) return null;
  const pts = [];
  const parcourir = (t) => {
    if (!Array.isArray(t)) return;
    if (typeof t[0] === 'number' && typeof t[1] === 'number') { pts.push(t); return; }
    t.forEach(parcourir);
  };
  parcourir(geom.coordinates);
  if (!pts.length) return null;
  const sx = pts.reduce((a, p) => a + p[0], 0);
  const sy = pts.reduce((a, p) => a + p[1], 0);
  return [sx / pts.length, sy / pts.length];
}

// ---------------------------------------------------------------------------
async function interroger(nom, cfg, jeton, insee, parcelle, rayon, brut, geo) {
  const params = new URLSearchParams();
  if (cfg.version === 'v2') {
    if (cfg.critere === 'parcelle') params.set('codesParcelle', parcelle);
    else params.set('codesInsee', insee);
    if (cfg.rayon) params.set('rayon', String(rayon));
    params.set('pageNumber', '0');
    params.set('pageSize', '1000');
  } else {
    params.set('code_insee', insee);
    params.set('page', '1');
    params.set('page_size', '500');
  }

  const url = `${BASE}${cfg.path}?${params.toString()}`;
  const entetes = { 'Accept': 'application/json' };
  if (cfg.version === 'v2') entetes['Authorization'] = `Bearer ${jeton}`;

  const t0 = Date.now();
  try {
    const rep = await fetch(url, { headers: entetes });
    const txt = await rep.text();
    let don = null;
    try { don = JSON.parse(txt); }
    catch {
      return { version: cfg.version, url_appelee: url, code_http: rep.status,
               lecture: interpreter(rep.status), duree_ms: Date.now() - t0,
               reponse_non_json: txt.slice(0, 300) };
    }

    const c = extraire(don);
    const out = {
      version: cfg.version,
      ial: cfg.ial || null,
      seuil: cfg.seuil || null,
      rayon_transmis: cfg.rayon ? rayon : null,
      url_appelee: url,
      code_http: rep.status,
      lecture: interpreter(rep.status),
      total_brut: c.total,
      duree_ms: Date.now() - t0
    };
    if (rep.status !== 200) return out;
    if (c.agregat) out.agregat = c.agregat;

    // --- Vocabulaire reel des regimes ICPE ------------------------------
    if (cfg.regimes && c.items.length) {
      const compte = {};
      for (const e of c.items) {
        const k = e.regime === null || e.regime === undefined ? '(null)' : String(e.regime);
        compte[k] = (compte[k] || 0) + 1;
      }
      out.regimes_observes = compte;
    }

    // --- Distances -------------------------------------------------------
    if (cfg.mesure && c.items.length && geo && geo.obtenu && geo.centroide) {
      const ref = [geo.centroide.longitude, geo.centroide.latitude];
      const mesures = c.items.map(e => {
        const p = cfg.mesure === 'geom'
          ? pointDeGeom(e.geom)
          : (typeof e.longitude === 'number' ? [e.longitude, e.latitude] : null);
        return {
          id: e.identifiantSsp || e.codeAIOT || e.identifiant || null,
          nom: e.nom || e.raisonSociale || null,
          statut: e.statut || e.etatActivite || null,
          regime: e.regime || null,
          adresse: e.adresse || e.adresse1 || null,
          fiche: e.ficheRisque || null,
          distance_m: p ? Math.round(haversine(ref, p)) : null
        };
      }).sort((a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9));

      const dans = mesures.filter(m => m.distance_m !== null && m.distance_m <= rayon);
      const hors = mesures.filter(m => m.distance_m !== null && m.distance_m > rayon);

      out.mesure_distances = {
        dans_le_rayon: dans.length,
        au_dela_du_rayon: hors.length,
        sans_coordonnees: mesures.filter(m => m.distance_m === null).length,
        distance_min_m: mesures.length ? mesures[0].distance_m : null,
        distance_max_m: mesures.length ? mesures[mesures.length - 1].distance_m : null,
        commentaire: hors.length
          ? "Ces entrees sont au-dela du rayon depuis le centroide : l'API a mesure depuis l'emprise parcellaire."
          : 'Toutes les entrees sont dans le rayon depuis le centroide.'
      };
      out.au_dela = hors.slice(0, 20);
      out.liste = dans.slice(0, 30);
    }

    // --- Filtre ICPE : ecarter les non-ICPE -----------------------------
    if (!brut && cfg.regimes && c.items.length) {
      const estIcpe = e => {
        const r = (e.regime || '').toString().toLowerCase();
        return r !== '' && !r.includes('non icpe');
      };
      const retenus = c.items.filter(estIcpe);
      out.filtre = 'entrees de regime "Non ICPE" ou vide ecartees';
      out.total_retenu = retenus.length;
      out.ecartes = c.items.length - retenus.length;
      out.icpe_retenues = retenus.slice(0, 20).map(e => ({
        nom: e.raisonSociale, regime: e.regime, etat: e.etatActivite,
        seveso: e.statutSeveso, codeAiot: e.codeAIOT
      }));
    }

    if (cfg.ial) out.qualification = qualifier(nom, c.items);

    if (c.items.some(e => e && e.zonageReglementaire)) {
      out.procedures = c.items.map(e => ({
        idGaspar: e.idGaspar, libelle: e.libPpr,
        en_zone: e.zonageReglementaire ? e.zonageReglementaire.zoneRegExists : null,
        zones: ((e.zonageReglementaire || {}).listTypeReg || []).map(z => z.codeZone)
      }));
    }

    if (!out.total_retenu && !out.mesure_distances && c.items.length) {
      out.total_retenu = c.items.length;
      out.premier = c.items[0];
    }

    return out;

  } catch (e) {
    return { version: cfg.version, url_appelee: url, code_http: 0,
             lecture: "L'appel a echoue avant reponse.", detail: e.message,
             duree_ms: Date.now() - t0 };
  }
}

function qualifier(nom, items) {
  if (!items.length) return { retenu: false, motif: 'aucune donnee pour cette parcelle' };

  if (nom === 'sismique') {
    const z = parseInt(items[0].typeZone, 10);
    return z >= 2
      ? { retenu: true, valeur: items[0].zoneSismicite,
          precision: "fiche d'information sur le risque sismique a joindre (R.125-24 2°)" }
      : { retenu: false, motif: `zone ${z} : l'obligation ne nait qu'a partir de la zone 2` };
  }
  if (nom === 'radon') {
    const c = parseInt(items[0].classePotentiel, 10);
    return c === 3
      ? { retenu: true, valeur: `potentiel radon niveau ${c}` }
      : { retenu: false, motif: `classe ${c} : seul le niveau 3 releve de l'obligation (R.125-23 6°)` };
  }
  if (nom === 'old') {
    return { retenu: true, valeur: 'zone de debroussaillement',
             precision: 'fiche a annexer : voir le champ url' };
  }
  if (['pprn', 'pprt', 'pprm'].includes(nom)) {
    const z = items.filter(e => e.zonageReglementaire && e.zonageReglementaire.zoneRegExists === true);
    return z.length
      ? { retenu: true, valeur: `${z.length} plan(s) avec zone delimitee applicable` }
      : { retenu: false,
          motif: `${items.length} procedure(s) sur la commune, mais aucune zone delimitee couvrant le bien (zoneRegExists faux)` };
  }
  return { retenu: false, motif: 'rubrique non qualifiee' };
}

function pointDeGeom(g) {
  if (!g) return null;
  if (g.type === 'Point' && Array.isArray(g.coordinates)) return g.coordinates;
  if (g.coordinates && typeof g.coordinates.longitude === 'number') {
    return [g.coordinates.longitude, g.coordinates.latitude];
  }
  return centroide(g);
}

function haversine(a, b) {
  const R = 6371000;
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function extraire(d) {
  if (!d) return { total: 0, items: [] };
  if (Array.isArray(d)) return { total: d.length, items: d };
  if (Array.isArray(d.content)) return { total: d.totalElements, items: d.content };
  if (Array.isArray(d.data)) return { total: d.results, items: d.data };
  if (d.casias || d.conclusionsSis) {
    return { total: null, items: [], agregat: {
      casias: d.casias ? d.casias.totalElements : null,
      instructions: d.instructions ? d.instructions.totalElements : null,
      sis: d.conclusionsSis ? d.conclusionsSis.totalElements : null,
      sup: d.conclusionsSup ? d.conclusionsSup.totalElements : null } };
  }
  return { total: null, items: [] };
}

function interpreter(c) {
  if (c === 200) return 'OK';
  if (c === 400) return 'Parametres invalides.';
  if (c === 401) return 'Jeton manquant.';
  if (c === 403) return 'Jeton invalide ou non habilite.';
  if (c === 404) return 'Chemin inconnu ou aucune ressource.';
  if (c === 429) return 'Quota depasse.';
  if (c >= 500) return 'Erreur cote Georisques, souvent un critere non supporte.';
  return `Code inattendu : ${c}`;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
