// RISQUES — /api/test.js
// Endpoint de diagnostic ET premiere implementation du moteur de qualification.
//
// Chemins etablis d'apres /api/v3/api-docs/georisques-api-v1 et -v2, valides
// par appel reel le 25/08/2026 sur la parcelle 62160-000-XM-0307, et recoupes
// avec l'ERRIAL officiel etabli le meme jour sur la meme parcelle.
//
// Quotas : v2 20 appels/s ; v1 5 appels/s ; 1 appel/s pour rapport_pdf.
//
// TROIS REGLES METIER, sans lesquelles le document serait inexact
//
// A. SEUILS REGLEMENTAIRES. Une rubrique qui renvoie des donnees ne releve pas
//    pour autant de l'obligation d'information. R.125-23 pose des seuils :
//    sismicite a partir de la zone 2, radon au seul niveau 3. Un radon en
//    classe 1 ne figure PAS au corps de l'etat des risques. Qualifier sur la
//    seule presence de donnees produirait un document faux par exces.
//
// B. REGIME ICPE. L'endpoint installations_classees renvoie tous les
//    etablissements connus de la base, y compris ceux dont le regime vaut
//    "Non ICPE". L'annexe de l'ERRIAL ne retient que les installations
//    soumises a autorisation (A) ou a enregistrement (E). Sans filtre :
//    50 resultats la ou l'ERRIAL en compte 1.
//
// C. CENTROIDE COMMUNAL CASIAS. L'ERRIAL ecarte les anciennes activites
//    geolocalisees par defaut au centre de la commune. Sans ce filtre :
//    40 resultats la ou l'ERRIAL en compte 27. Ces entrees se detectent par
//    l'amas de coordonnees strictement identiques qu'elles forment.
//
// Le jeton n'est jamais renvoye au client : seules sa presence et sa longueur
// sont exposees.
//
// Usage :
//   /api/test
//   /api/test?rubrique=casias
//   /api/test?rayon=500&brut=1        (brut=1 desactive les filtres B et C)

const BASE = 'https://www.georisques.gouv.fr';

const DEFAUTS = {
  insee: '62160',
  parcelle: '62160-000-XM-0307',
  rayon: 500
};

// Nombre d'entrees partageant des coordonnees identiques au-dela duquel on
// considere qu'il s'agit du centroide communal et non d'une localisation reelle.
const SEUIL_AMAS = 3;

const RUBRIQUES = {
  // --- Corps de l'etat des risques : les huit items de R.125-23 -----------
  sismique:  { version: 'v2', path: '/api/v2/zonage_sismique', critere: 'parcelle', ial: '5°',
               seuil: 'zone >= 2' },
  radon:     { version: 'v2', path: '/api/v2/radon', critere: 'parcelle', ial: '6°',
               seuil: 'classe = 3 uniquement' },
  old:       { version: 'v2', path: '/api/v2/old', critere: 'parcelle', ial: '8°',
               seuil: 'presence d\'une zone' },
  pprn:      { version: 'v2', path: '/api/v2/gaspar/pprn', critere: 'parcelle', ial: '2° et 4°',
               seuil: 'zoneRegExists = true' },
  pprt:      { version: 'v2', path: '/api/v2/gaspar/pprt', critere: 'parcelle', ial: '1° et 4°',
               seuil: 'zoneRegExists = true' },
  pprm:      { version: 'v2', path: '/api/v2/gaspar/pprm', critere: 'parcelle', ial: '3° et 4°',
               seuil: 'zoneRegExists = true' },
  // 7° recul du trait de cote : Geoportail de l'urbanisme, hors Georisques.

  // --- Annexe 1 : hors obligation IAL ------------------------------------
  rga:       { version: 'v2', path: '/api/v2/rga', critere: 'parcelle' },
  casias:    { version: 'v2', path: '/api/v2/ssp/casias', critere: 'parcelle', rayon: true,
               filtre: 'centroide' },
  sis:       { version: 'v2', path: '/api/v2/ssp/conclusions_sis', critere: 'parcelle', rayon: true },
  sup:       { version: 'v2', path: '/api/v2/ssp/conclusions_sup', critere: 'parcelle', rayon: true },
  ssp:       { version: 'v2', path: '/api/v2/ssp', critere: 'parcelle', rayon: true },
  icpe:      { version: 'v2', path: '/api/v2/installations_classees', critere: 'parcelle', rayon: true,
               filtre: 'regime' },
  mvt:       { version: 'v2', path: '/api/v2/mvt', critere: 'insee' },
  cavites:   { version: 'v2', path: '/api/v2/cavites', critere: 'insee' },
  nucleaire: { version: 'v2', path: '/api/v2/installations_nucleaires', critere: 'parcelle' },

  // --- Contexte ----------------------------------------------------------
  tri:       { version: 'v2', path: '/api/v2/gaspar/tri', critere: 'parcelle' },
  azi:       { version: 'v2', path: '/api/v2/gaspar/azi', critere: 'parcelle' },
  papi:      { version: 'v2', path: '/api/v2/gaspar/papi', critere: 'parcelle' },
  dicrim:    { version: 'v2', path: '/api/v2/gaspar/dicrim', critere: 'parcelle' },
  risques:   { version: 'v2', path: '/api/v2/gaspar/risques', critere: 'parcelle' },

  // --- Uniquement en v1 --------------------------------------------------
  catnat:    { version: 'v1', path: '/api/v1/gaspar/catnat', critere: 'insee' }
};

export default async function handler(req, res) {
  const depart = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;

  const insee = (req.query.insee || DEFAUTS.insee).toString();
  const parcelle = (req.query.parcelle || DEFAUTS.parcelle).toString();
  const rayon = (req.query.rayon || DEFAUTS.rayon).toString();
  const brut = req.query.brut === '1';
  const demandee = req.query.rubrique ? req.query.rubrique.toString() : null;

  const socle = {
    horodatage: new Date().toISOString(),
    jeton: { present: Boolean(jeton), longueur: jeton ? jeton.length : 0 },
    parametres: { insee, parcelle, rayon_metres: Number(rayon), filtres_actifs: !brut }
  };

  if (!jeton) {
    return res.status(500).json({
      ...socle,
      resultat: 'ECHEC',
      cause: "Variable d'environnement GEORISQUES_TOKEN absente.",
      remede: [
        'Vercel > projet risques > Settings > Environment Variables',
        'Cle : GEORISQUES_TOKEN (aucun prefixe NEXT_PUBLIC_ ni VITE_)',
        'Cocher Production, Preview et Development, puis REDEPLOYER.'
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
    resultats[nom] = await interroger(nom, RUBRIQUES[nom], jeton, insee, parcelle, rayon, brut);
    if (aTester.length > 1) await pause(120);
  }

  const succes = Object.values(resultats).filter(r => r.code_http === 200).length;

  // --- Qualification au titre de l'obligation d'information --------------
  const corps = [];
  const ecartes = [];
  for (const [nom, r] of Object.entries(resultats)) {
    const cfg = RUBRIQUES[nom];
    if (!cfg.ial || r.code_http !== 200) continue;
    if (r.qualification && r.qualification.retenu) {
      corps.push({ rubrique: nom, article: cfg.ial, valeur: r.qualification.valeur });
    } else if (r.qualification) {
      ecartes.push({ rubrique: nom, article: cfg.ial, motif: r.qualification.motif });
    }
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
    etat_des_risques: {
      corps: corps,
      ecartes_du_corps: ecartes,
      rappel: "Le 7° (recul du trait de cote) n'est pas couvert par Georisques : Geoportail de l'urbanisme."
    },
    rubriques: resultats
  });
}

async function interroger(nom, cfg, jeton, insee, parcelle, rayon, brut) {
  const params = new URLSearchParams();

  if (cfg.version === 'v2') {
    if (cfg.critere === 'parcelle') params.set('codesParcelle', parcelle);
    else params.set('codesInsee', insee);
    if (cfg.rayon) params.set('rayon', rayon);
    params.set('pageNumber', '0');
    params.set('pageSize', '1000');     // evite la troncature a 50
  } else {
    params.set('code_insee', insee);
    if (cfg.rayon) params.set('rayon', rayon);
    params.set('page', '1');
    params.set('page_size', '500');
  }

  const url = `${BASE}${cfg.path}?${params.toString()}`;
  const entetes = { 'Accept': 'application/json' };
  if (cfg.version === 'v2') entetes['Authorization'] = `Bearer ${jeton}`;

  const t0 = Date.now();
  try {
    const reponse = await fetch(url, { method: 'GET', headers: entetes });
    const texte = await reponse.text();

    let donnees = null;
    try { donnees = JSON.parse(texte); }
    catch {
      return {
        version: cfg.version, url_appelee: url, code_http: reponse.status,
        lecture: interpreter(reponse.status), duree_ms: Date.now() - t0,
        reponse_non_json: texte.slice(0, 300)
      };
    }

    const contenu = extraireContenu(donnees);
    const sortie = {
      version: cfg.version,
      ial: cfg.ial || null,
      seuil: cfg.seuil || null,
      rayon_transmis: cfg.rayon ? Number(rayon) : null,
      url_appelee: url,
      code_http: reponse.status,
      lecture: interpreter(reponse.status),
      total_brut: contenu.total,
      duree_ms: Date.now() - t0
    };

    if (reponse.status !== 200) return sortie;

    // Filtres de restitution
    if (!brut && cfg.filtre === 'regime') {
      const retenus = contenu.items.filter(e => e && (e.regime === 'A' || e.regime === 'E'));
      sortie.filtre = 'regime A ou E (installations soumises a autorisation ou enregistrement)';
      sortie.total_retenu = retenus.length;
      sortie.ecartes = contenu.items.length - retenus.length;
      sortie.liste = retenus.slice(0, 20).map(e => ({
        nom: e.raisonSociale, regime: e.regime, etat: e.etatActivite,
        seveso: e.statutSeveso, codeAiot: e.codeAIOT,
        distance_m: distance(e.longitude, e.latitude)
      }));
    } else if (!brut && cfg.filtre === 'centroide') {
      const tri = ecarterCentroide(contenu.items);
      sortie.filtre = `entrees geolocalisees par defaut ecartees (amas >= ${SEUIL_AMAS} points identiques)`;
      sortie.total_retenu = tri.retenus.length;
      sortie.ecartes = tri.ecartes.length;
      sortie.amas_detectes = tri.amas;
      sortie.liste = tri.retenus.slice(0, 30).map(e => ({
        nom: e.nom, activite: e.activitePrincipale, statut: e.statut,
        adresse: e.adresse, fiche: e.ficheRisque,
        distance_m: distanceGeom(e.geom)
      }));
    } else if (contenu.items.length) {
      sortie.total_retenu = contenu.items.length;
      sortie.premier = contenu.items[0];
    }

    // Qualification au titre de R.125-23
    if (cfg.ial) sortie.qualification = qualifier(nom, contenu.items);

    // Zonage reglementaire des PPR
    if (contenu.items.some(e => e && e.zonageReglementaire)) {
      const enZone = contenu.items.filter(
        e => e.zonageReglementaire && e.zonageReglementaire.zoneRegExists === true
      );
      sortie.procedures = contenu.items.map(e => ({
        idGaspar: e.idGaspar, libelle: e.libPpr,
        en_zone: e.zonageReglementaire ? e.zonageReglementaire.zoneRegExists : null,
        zones: (e.zonageReglementaire && e.zonageReglementaire.listTypeReg || []).map(z => z.codeZone)
      }));
      sortie.procedures_en_zone = enZone.length;
    }

    return sortie;

  } catch (erreur) {
    return {
      version: cfg.version, url_appelee: url, code_http: 0,
      lecture: "L'appel a echoue avant reponse.", detail: erreur.message,
      duree_ms: Date.now() - t0
    };
  }
}

// ---------------------------------------------------------------------------
// Qualification : application des seuils de R.125-23
// ---------------------------------------------------------------------------
function qualifier(nom, items) {
  if (!items.length) {
    return { retenu: false, motif: 'aucune donnee pour cette parcelle' };
  }

  if (nom === 'sismique') {
    const zone = parseInt(items[0].typeZone, 10);
    return zone >= 2
      ? { retenu: true, valeur: items[0].zoneSismicite,
          precision: 'fiche d\'information sur le risque sismique a joindre (R.125-24 2°)' }
      : { retenu: false, motif: `zone ${zone} : l'obligation ne nait qu'a partir de la zone 2` };
  }

  if (nom === 'radon') {
    const classe = parseInt(items[0].classePotentiel, 10);
    return classe === 3
      ? { retenu: true, valeur: `potentiel radon niveau ${classe}` }
      : { retenu: false, motif: `classe ${classe} : seul le niveau 3 releve de l'obligation (R.125-23 6°)` };
  }

  if (nom === 'old') {
    return { retenu: true, valeur: 'zone de debroussaillement',
             precision: 'fiche a annexer : voir le champ url' };
  }

  if (nom === 'pprn' || nom === 'pprt' || nom === 'pprm') {
    const enZone = items.filter(
      e => e.zonageReglementaire && e.zonageReglementaire.zoneRegExists === true
    );
    return enZone.length
      ? { retenu: true, valeur: `${enZone.length} plan(s) avec zone delimitee applicable` }
      : { retenu: false,
          motif: `${items.length} procedure(s) sur la commune, mais aucune zone delimitee couvrant le bien (zoneRegExists faux)` };
  }

  return { retenu: false, motif: 'rubrique non qualifiee' };
}

// ---------------------------------------------------------------------------
// Detection des entrees geolocalisees par defaut au centre de la commune :
// elles partagent des coordonnees strictement identiques en nombre.
// ---------------------------------------------------------------------------
function ecarterCentroide(items) {
  const paquets = new Map();
  for (const e of items) {
    const c = coordonnees(e.geom);
    const cle = c ? `${c[0].toFixed(6)},${c[1].toFixed(6)}` : 'sans_geometrie';
    if (!paquets.has(cle)) paquets.set(cle, []);
    paquets.get(cle).push(e);
  }

  const retenus = [];
  const ecartes = [];
  const amas = [];

  for (const [cle, groupe] of paquets.entries()) {
    if (cle !== 'sans_geometrie' && groupe.length >= SEUIL_AMAS) {
      amas.push({ coordonnees: cle, effectif: groupe.length });
      ecartes.push(...groupe);
    } else {
      retenus.push(...groupe);
    }
  }

  return { retenus, ecartes, amas };
}

function coordonnees(geom) {
  if (!geom) return null;
  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) return geom.coordinates;
  if (geom.coordinates && typeof geom.coordinates.longitude === 'number') {
    return [geom.coordinates.longitude, geom.coordinates.latitude];
  }
  return null;
}

// Distance a la parcelle : non calculee ici faute des coordonnees du bien.
// A brancher lorsque le geocodage de la parcelle sera en place.
function distance() { return null; }
function distanceGeom() { return null; }

function extraireContenu(d) {
  if (!d) return { total: 0, items: [] };
  if (Array.isArray(d)) return { total: d.length, items: d };
  if (Array.isArray(d.content)) return { total: d.totalElements, items: d.content };
  if (Array.isArray(d.data)) return { total: d.results, items: d.data };
  if (d.casias || d.conclusionsSis) {
    return {
      total: null,
      items: [],
      agregat: {
        casias: d.casias ? d.casias.totalElements : null,
        instructions: d.instructions ? d.instructions.totalElements : null,
        sis: d.conclusionsSis ? d.conclusionsSis.totalElements : null,
        sup: d.conclusionsSup ? d.conclusionsSup.totalElements : null
      }
    };
  }
  return { total: null, items: [], objet: Object.keys(d).slice(0, 20) };
}

function interpreter(code) {
  if (code === 200) return 'OK';
  if (code === 400) return 'Parametres invalides.';
  if (code === 401) return 'Jeton manquant cote requete.';
  if (code === 403) return 'Jeton invalide ou non habilite.';
  if (code === 404) return 'Chemin inconnu ou aucune ressource.';
  if (code === 429) return 'Quota depasse.';
  if (code >= 500) return "Erreur cote Georisques, souvent un critere non supporte.";
  return `Code inattendu : ${code}`;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
