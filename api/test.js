// RISQUES — /api/test.js
// Endpoint de diagnostic. Chemins etablis d'apres les specifications OpenAPI
// officielles (/api/v3/api-docs/georisques-api-v1 et -v2) et valides par appel
// reel le 25/08/2026 sur la parcelle 62160-000-XM-0307.
//
// Quotas annonces : v2 20 appels/s ; v1 5 appels/s ; 1 appel/s pour rapport_pdf
// et resultats_rapport_risque.
//
// POINTS DE VIGILANCE INTEGRES A CETTE VERSION
//
// 1. RAYON. Le parametre rayon vaut 0 par defaut : l'interrogation ne porte
//    alors que sur la parcelle elle-meme. Sur les rubriques de proximite
//    (CASIAS, ICPE, SIS, SUP, MVT, cavites), cela produit des faux negatifs.
//    L'ERRIAL de reference recense 1 ICPE et 27 CASIAS dans 500 m, la ou un
//    appel sans rayon renvoie zero. Le rayon est donc explicite.
//
// 2. zoneRegExists. Pour les PPR, la seule presence d'une procedure sur la
//    commune ne declenche pas l'obligation IAL : R.125-23 exige que le bien
//    soit dans une ZONE DELIMITEE. Le champ zonageReglementaire.zoneRegExists
//    est le discriminant. Faux => la procedure existe mais ne va pas au corps
//    de l'etat des risques.
//
// 3. Le jeton n'est jamais renvoye au client : seules sa presence et sa
//    longueur sont exposees.
//
// Usage :
//   /api/test
//   /api/test?rubrique=casias
//   /api/test?rayon=1000
//   /api/test?parcelle=62160-000-XM-0307&insee=62160

const BASE = 'https://www.georisques.gouv.fr';

const DEFAUTS = {
  insee: '62160',
  parcelle: '62160-000-XM-0307',
  rayon: 500          // rayon de reference de l'ERRIAL pour la pollution des sols
};

// ---------------------------------------------------------------------------
// cle          : nom de la rubrique
// version      : 'v2' (jeton obligatoire) ou 'v1' (libre)
// path         : chemin exact
// critere      : 'parcelle' ou 'insee'
// rayon        : true si le rayon doit etre transmis
// ial          : true si la rubrique releve du corps de l'ERP (R.125-23)
// ---------------------------------------------------------------------------
const RUBRIQUES = {
  // --- Corps de l'ERP : les huit items de R.125-23 -------------------------
  sismique:  { version: 'v2', path: '/api/v2/zonage_sismique', critere: 'parcelle', ial: true,
               note: "R.125-23 5° — obligation des la zone 2. Valide : 2 - FAIBLE, conforme a l'ERRIAL." },
  radon:     { version: 'v2', path: '/api/v2/radon', critere: 'parcelle', ial: true,
               note: "R.125-23 6° — seul le niveau 3 declenche l'obligation. Valide : classe 1." },
  old:       { version: 'v2', path: '/api/v2/old', critere: 'parcelle', ial: true,
               note: "R.125-23 8° — le champ url porte la fiche a annexer. Endpoint operationnel." },
  pprn:      { version: 'v2', path: '/api/v2/gaspar/pprn', critere: 'parcelle', ial: true,
               note: "R.125-23 2° et 4°. LIRE zoneRegExists : deux procedures trouvees mais hors zone delimitee." },
  pprt:      { version: 'v2', path: '/api/v2/gaspar/pprt', critere: 'parcelle', ial: true,
               note: "R.125-23 1° et 4°. Idem : lire zoneRegExists." },
  pprm:      { version: 'v2', path: '/api/v2/gaspar/pprm', critere: 'parcelle', ial: true,
               note: "R.125-23 3° et 4°. Idem : lire zoneRegExists." },

  // --- Annexe 1 : hors obligation IAL, rubriques de proximite -------------
  rga:       { version: 'v2', path: '/api/v2/rga', critere: 'parcelle', ial: false,
               note: "Valide : exposition moyenne (2/3), conforme a l'ERRIAL." },
  casias:    { version: 'v2', path: '/api/v2/ssp/casias', critere: 'parcelle', rayon: true, ial: false,
               note: "RAYON INDISPENSABLE. ERRIAL de reference : 27 sites dans 500 m." },
  sis:       { version: 'v2', path: '/api/v2/ssp/conclusions_sis', critere: 'parcelle', rayon: true, ial: false,
               note: "Libelles inverses dans le swagger : se fier au schema de retour, pas au resume." },
  sup:       { version: 'v2', path: '/api/v2/ssp/conclusions_sup', critere: 'parcelle', rayon: true, ial: false,
               note: "Idem : libelles inverses cote documentation." },
  ssp:       { version: 'v2', path: '/api/v2/ssp', critere: 'parcelle', rayon: true, ial: false,
               note: "Agregat : casias + instructions + SIS + SUP en un appel." },
  icpe:      { version: 'v2', path: '/api/v2/installations_classees', critere: 'parcelle', rayon: true, ial: false,
               note: "RAYON INDISPENSABLE. ERRIAL de reference : 1 installation dans 500 m." },
  mvt:       { version: 'v2', path: '/api/v2/mvt', critere: 'insee', rayon: false, ial: false,
               note: "Renvoyait 500 avec codesParcelle : bascule sur codesInsee." },
  cavites:   { version: 'v2', path: '/api/v2/cavites', critere: 'insee', rayon: false, ial: false,
               note: "Renvoyait 500 avec codesParcelle : bascule sur codesInsee." },
  nucleaire: { version: 'v2', path: '/api/v2/installations_nucleaires', critere: 'parcelle', ial: false },

  // --- Contexte -----------------------------------------------------------
  tri:       { version: 'v2', path: '/api/v2/gaspar/tri', critere: 'parcelle', ial: false },
  azi:       { version: 'v2', path: '/api/v2/gaspar/azi', critere: 'parcelle', ial: false },
  papi:      { version: 'v2', path: '/api/v2/gaspar/papi', critere: 'parcelle', ial: false },
  dicrim:    { version: 'v2', path: '/api/v2/gaspar/dicrim', critere: 'parcelle', ial: false },
  risques:   { version: 'v2', path: '/api/v2/gaspar/risques', critere: 'parcelle', ial: false },

  // --- Uniquement disponible en v1 ---------------------------------------
  catnat:    { version: 'v1', path: '/api/v1/gaspar/catnat', critere: 'insee', ial: false,
               note: "ABSENT DE LA v2. Exige par R.125-24 5°. Architecture hybride imposee. Valide : 25 arretes." }
};

export default async function handler(req, res) {
  const depart = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;

  const insee = (req.query.insee || DEFAUTS.insee).toString();
  const parcelle = (req.query.parcelle || DEFAUTS.parcelle).toString();
  const rayon = (req.query.rayon || DEFAUTS.rayon).toString();
  const demandee = req.query.rubrique ? req.query.rubrique.toString() : null;

  const socle = {
    horodatage: new Date().toISOString(),
    jeton: { present: Boolean(jeton), longueur: jeton ? jeton.length : 0 },
    parametres: { insee, parcelle, rayon_metres: Number(rayon) }
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
        'Puis REDEPLOYER.'
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

  for (const nom of aTester) {
    resultats[nom] = await interroger(RUBRIQUES[nom], jeton, insee, parcelle, rayon);
    if (aTester.length > 1) await pause(120);
  }

  const succes = Object.values(resultats).filter(r => r.code_http === 200).length;

  // Synthese metier : ce qui irait effectivement au corps de l'etat des risques.
  const corps_erp = [];
  for (const [nom, r] of Object.entries(resultats)) {
    if (!RUBRIQUES[nom].ial || r.code_http !== 200) continue;
    if (r.zone_delimitee === false) continue;   // PPR hors zone : exclu du corps
    if (r.total === 0) continue;                 // rubrique non concernee
    corps_erp.push(nom);
  }

  return res.status(200).json({
    ...socle,
    resultat: succes === aTester.length ? 'SUCCES' : 'PARTIEL',
    synthese: {
      testees: aTester.length,
      en_succes: succes,
      en_echec: aTester.length - succes,
      duree_totale_ms: Date.now() - depart
    },
    corps_erp_pressenti: corps_erp,
    rubriques: resultats
  });
}

async function interroger(cfg, jeton, insee, parcelle, rayon) {
  const params = new URLSearchParams();

  if (cfg.version === 'v2') {
    // v2 : camelCase, pageNumber commence a 0, pageSize jusqu'a 1000.
    if (cfg.critere === 'parcelle') params.set('codesParcelle', parcelle);
    else params.set('codesInsee', insee);
    if (cfg.rayon) params.set('rayon', rayon);
    params.set('pageNumber', '0');
    params.set('pageSize', '50');
  } else {
    // v1 : snake_case, page commence a 1, pas de critere parcelle.
    params.set('code_insee', insee);
    if (cfg.rayon) params.set('rayon', rayon);
    params.set('page', '1');
    params.set('page_size', '50');
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

    const lu = json_valide ? extraire(donnees) : null;

    return {
      version: cfg.version,
      ial: Boolean(cfg.ial),
      rayon_transmis: cfg.rayon ? Number(rayon) : null,
      url_appelee: url,
      code_http: reponse.status,
      lecture: interpreter(reponse.status),
      total: lu ? lu.total : null,
      zone_delimitee: lu ? lu.zone_delimitee : undefined,
      duree_ms: Date.now() - t0,
      note: cfg.note || null,
      extrait: json_valide ? lu : donnees
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
  if (code >= 500) return "Erreur cote Georisques. Souvent un critere non supporte par l'endpoint.";
  return `Code inattendu : ${code}`;
}

function extraire(d) {
  if (!d) return null;

  if (Array.isArray(d)) {
    return { forme: 'tableau', total: d.length, premier: d[0] || null };
  }

  // v2 : totalElements / content
  if (typeof d.totalElements !== 'undefined') {
    const contenu = Array.isArray(d.content) ? d.content : [];
    const sortie = {
      forme: 'v2',
      total: d.totalElements,
      pages: d.totalPages,
      recus: contenu.length,
      premier: contenu[0] || null
    };
    // Discriminant de l'obligation IAL pour les PPR.
    const avecZone = contenu.filter(
      e => e && e.zonageReglementaire && e.zonageReglementaire.zoneRegExists === true
    );
    if (contenu.some(e => e && e.zonageReglementaire)) {
      sortie.zone_delimitee = avecZone.length > 0;
      sortie.procedures_en_zone = avecZone.length;
      sortie.procedures_hors_zone = contenu.length - avecZone.length;
      sortie.zones_applicables = avecZone.flatMap(
        e => (e.zonageReglementaire.listTypeReg || []).map(z => z.codeZone)
      );
    }
    // Liste nommee pour les rubriques de proximite.
    if (contenu.length && (contenu[0].raisonSociale || contenu[0].nom)) {
      sortie.noms = contenu.slice(0, 10).map(e => ({
        nom: e.raisonSociale || e.nom || null,
        statut: e.etatActivite || e.statut || null,
        activite: e.activitePrincipale || null,
        fiche: e.ficheRisque || null
      }));
    }
    return sortie;
  }

  // v1 : results / data
  if (typeof d.results !== 'undefined') {
    const contenu = Array.isArray(d.data) ? d.data : [];
    return {
      forme: 'v1',
      total: d.results,
      pages: d.total_pages,
      recus: contenu.length,
      premier: contenu[0] || null
    };
  }

  // Agregat SSP : quatre sous-ensembles paginés.
  if (d.casias || d.conclusionsSis) {
    return {
      forme: 'agregat_ssp',
      casias: d.casias ? d.casias.totalElements : null,
      instructions: d.instructions ? d.instructions.totalElements : null,
      sis: d.conclusionsSis ? d.conclusionsSis.totalElements : null,
      sup: d.conclusionsSup ? d.conclusionsSup.totalElements : null
    };
  }

  return { forme: 'objet', cles: Object.keys(d).slice(0, 20) };
}

function pause(ms) {
  return new Promise(r => setTimeout(r, ms));
}
