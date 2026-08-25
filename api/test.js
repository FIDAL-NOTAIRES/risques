// RISQUES — /api/test.js
// Endpoint de diagnostic, chemins etablis d'apres les specifications OpenAPI
// officielles :
//   v1 : /api/v3/api-docs/georisques-api-v1
//   v2 : /api/v3/api-docs/georisques-api-v2
//
// Quotas annonces par la documentation :
//   v2  : 20 appels/s
//   v1  : 5 appels/s
//   v1  : 1 appel/s pour rapport_pdf et resultats_rapport_risque
//
// Le jeton n'est JAMAIS renvoye au client : seules sa presence et sa longueur
// sont exposees, a des fins de diagnostic.
//
// Usage :
//   /api/test                       -> balaye toutes les rubriques
//   /api/test?rubrique=old          -> une seule rubrique
//   /api/test?insee=62160
//   /api/test?parcelle=62160-000-XM-0307

const BASE = 'https://www.georisques.gouv.fr';

// Parcelle de reference : 000-XM-307, 62200 Boulogne-sur-Mer.
// Format impose par la v2 : commune-prefixe-section-numero, avec tirets.
const DEFAUTS = {
  insee: '62160',
  parcelle: '62160-000-XM-0307'
};

// ---------------------------------------------------------------------------
// Table des rubriques.
//   version   : 'v2' (jeton obligatoire) ou 'v1' (libre)
//   path      : chemin exact
//   parcelle  : true si l'endpoint accepte codesParcelle
//   ial       : true si la rubrique releve du corps de l'ERP (R.125-23)
// ---------------------------------------------------------------------------
const RUBRIQUES = {
  // --- Corps de l'ERP : les huit items de R.125-23 -------------------------
  sismique:   { version: 'v2', path: '/api/v2/zonage_sismique',   parcelle: true,  ial: true,
                note: 'R.125-23 5° — obligation des la zone 2' },
  radon:      { version: 'v2', path: '/api/v2/radon',             parcelle: true,  ial: true,
                note: 'R.125-23 6° — seul le niveau 3 declenche l\'obligation' },
  old:        { version: 'v2', path: '/api/v2/old',               parcelle: true,  ial: true,
                note: 'R.125-23 8° — le champ url porte la fiche a annexer' },
  pprn:       { version: 'v2', path: '/api/v2/gaspar/pprn',       parcelle: true,  ial: true,
                note: 'R.125-23 2° et 4° — ne pas filtrer sur le statut approuve' },
  pprt:       { version: 'v2', path: '/api/v2/gaspar/pprt',       parcelle: true,  ial: true,
                note: 'R.125-23 1° et 4°' },
  pprm:       { version: 'v2', path: '/api/v2/gaspar/pprm',       parcelle: true,  ial: true,
                note: 'R.125-23 3° et 4°' },

  // --- Annexe 1 : hors obligation IAL -------------------------------------
  rga:        { version: 'v2', path: '/api/v2/rga',               parcelle: true,  ial: false,
                note: 'Etude geotechnique obligatoire en exposition moyenne et forte' },
  casias:     { version: 'v2', path: '/api/v2/ssp/casias',        parcelle: true,  ial: false,
                note: 'geom exploitable pour calculer la distance au bien' },
  sis:        { version: 'v2', path: '/api/v2/ssp/conclusions_sis', parcelle: true, ial: false,
                note: 'Libelles inverses dans le swagger : se fier au schema, pas au resume' },
  sup:        { version: 'v2', path: '/api/v2/ssp/conclusions_sup', parcelle: true, ial: false,
                note: 'Idem : libelles inverses cote documentation' },
  ssp:        { version: 'v2', path: '/api/v2/ssp',               parcelle: true,  ial: false,
                note: 'Agregat : casias + instructions + SIS + SUP en un appel' },
  icpe:       { version: 'v2', path: '/api/v2/installations_classees', parcelle: true, ial: false,
                note: 'Liste nommee : raisonSociale, etatActivite, regime, statutSeveso' },
  mvt:        { version: 'v2', path: '/api/v2/mvt',               parcelle: true,  ial: false },
  cavites:    { version: 'v2', path: '/api/v2/cavites',           parcelle: true,  ial: false },
  nucleaire:  { version: 'v2', path: '/api/v2/installations_nucleaires', parcelle: true, ial: false },

  // --- Contexte -----------------------------------------------------------
  tri:        { version: 'v2', path: '/api/v2/gaspar/tri',        parcelle: true,  ial: false },
  azi:        { version: 'v2', path: '/api/v2/gaspar/azi',        parcelle: true,  ial: false },
  papi:       { version: 'v2', path: '/api/v2/gaspar/papi',       parcelle: true,  ial: false },
  dicrim:     { version: 'v2', path: '/api/v2/gaspar/dicrim',     parcelle: true,  ial: false },
  risques:    { version: 'v2', path: '/api/v2/gaspar/risques',    parcelle: true,  ial: false },

  // --- Uniquement disponible en v1 ---------------------------------------
  catnat:     { version: 'v1', path: '/api/v1/gaspar/catnat',     parcelle: false, ial: false,
                note: 'ABSENT DE LA v2. Exige par R.125-24 5°. Architecture hybride imposee.' }
};

export default async function handler(req, res) {
  const depart = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;

  const insee = (req.query.insee || DEFAUTS.insee).toString();
  const parcelle = (req.query.parcelle || DEFAUTS.parcelle).toString();
  const demandee = req.query.rubrique ? req.query.rubrique.toString() : null;

  const socle = {
    horodatage: new Date().toISOString(),
    jeton: { present: Boolean(jeton), longueur: jeton ? jeton.length : 0 },
    parametres: { insee, parcelle }
  };

  if (!jeton) {
    return res.status(500).json({
      ...socle,
      resultat: 'ECHEC',
      cause: "Variable d'environnement GEORISQUES_TOKEN absente.",
      remede: [
        'Vercel > projet risques > Settings > Environment Variables',
        'Cle : GEORISQUES_TOKEN (aucun prefixe NEXT_PUBLIC_ ni VITE_)',
        'Cocher Production, Preview et Development',
        'Puis REDEPLOYER : une variable ajoutee apres un deploiement',
        "n'est pas prise en compte par celui-ci."
      ]
    });
  }

  if (demandee && !RUBRIQUES[demandee]) {
    return res.status(400).json({
      ...socle,
      resultat: 'ECHEC',
      cause: `Rubrique inconnue : ${demandee}`,
      rubriques_disponibles: Object.keys(RUBRIQUES)
    });
  }

  const aTester = demandee ? [demandee] : Object.keys(RUBRIQUES);
  const resultats = {};

  // Sequentiel volontairement : la v1 est limitee a 5 appels/s.
  for (const nom of aTester) {
    resultats[nom] = await interroger(nom, RUBRIQUES[nom], jeton, insee, parcelle);
    if (aTester.length > 1) await pause(120);
  }

  const codes = Object.values(resultats).map(r => r.code_http);
  const succes = codes.filter(c => c === 200).length;

  return res.status(200).json({
    ...socle,
    resultat: succes === aTester.length ? 'SUCCES' : 'PARTIEL',
    synthese: {
      testees: aTester.length,
      en_succes: succes,
      en_echec: aTester.length - succes,
      duree_totale_ms: Date.now() - depart
    },
    rubriques: resultats
  });
}

async function interroger(nom, cfg, jeton, insee, parcelle) {
  const params = new URLSearchParams();

  if (cfg.version === 'v2') {
    // v2 : camelCase, pageNumber commence a 0, pageSize jusqu'a 1000.
    if (cfg.parcelle) params.set('codesParcelle', parcelle);
    else params.set('codesInsee', insee);
    params.set('pageNumber', '0');
    params.set('pageSize', '10');
  } else {
    // v1 : snake_case, page commence a 1, pas de critere parcelle.
    params.set('code_insee', insee);
    params.set('page', '1');
    params.set('page_size', '10');
  }

  const url = `${BASE}${cfg.path}?${params.toString()}`;
  const entetes = { 'Accept': 'application/json' };
  if (cfg.version === 'v2') entetes['Authorization'] = `Bearer ${jeton}`;

  const t0 = Date.now();
  try {
    const reponse = await fetch(url, { method: 'GET', headers: entetes });
    const brut = await reponse.text();

    let donnees = null;
    let json_valide = false;
    try { donnees = JSON.parse(brut); json_valide = true; }
    catch { donnees = brut.slice(0, 400); }

    return {
      version: cfg.version,
      ial: Boolean(cfg.ial),
      url_appelee: url,
      code_http: reponse.status,
      lecture: interpreter(reponse.status),
      json_valide,
      duree_ms: Date.now() - t0,
      note: cfg.note || null,
      extrait: json_valide ? extraire(donnees) : donnees
    };
  } catch (erreur) {
    return {
      version: cfg.version,
      ial: Boolean(cfg.ial),
      url_appelee: url,
      code_http: 0,
      lecture: "L'appel a echoue avant reponse.",
      detail: erreur.message,
      duree_ms: Date.now() - t0,
      note: cfg.note || null
    };
  }
}

function interpreter(code) {
  if (code === 200) return 'OK';
  if (code === 400) return 'Parametres invalides. Verifier le format de la parcelle ou du code INSEE.';
  if (code === 401) return 'Jeton manquant cote requete.';
  if (code === 403) return 'Jeton invalide ou non habilite.';
  if (code === 404) return 'Chemin inconnu ou aucune ressource pour ces criteres.';
  if (code === 429) return 'Quota depasse. Espacer les appels.';
  if (code >= 500) return 'Erreur cote Georisques. Reessayer avant de conclure.';
  return `Code inattendu : ${code}`;
}

function extraire(d) {
  if (!d) return null;
  if (Array.isArray(d)) {
    return { forme: 'tableau', total: d.length, premier: d[0] || null };
  }
  // v2 : totalElements / content
  if (typeof d.totalElements !== 'undefined') {
    return {
      forme: 'v2',
      total: d.totalElements,
      pages: d.totalPages,
      recus: Array.isArray(d.content) ? d.content.length : 0,
      premier: Array.isArray(d.content) ? (d.content[0] || null) : null
    };
  }
  // v1 : results / data
  if (typeof d.results !== 'undefined') {
    return {
      forme: 'v1',
      total: d.results,
      pages: d.total_pages,
      recus: Array.isArray(d.data) ? d.data.length : 0,
      premier: Array.isArray(d.data) ? (d.data[0] || null) : null
    };
  }
  return { forme: 'objet', cles: Object.keys(d).slice(0, 20) };
}

function pause(ms) {
  return new Promise(r => setTimeout(r, ms));
}
