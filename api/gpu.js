// RISQUES — /api/gpu.js
//
// Diagnostic du Geoportail de l'urbanisme via le module GPU d'API Carto.
//
// OBJET
// Le 7° de R.125-23 vise les zones exposees au recul du trait de cote,
// delimitees par un PLU, un document en tenant lieu ou une carte communale,
// ou determinees par une carte de prefiguration. Ces zones ne sont PAS dans
// Georisques : elles relevent des documents d'urbanisme (addendum v9 et v11).
//
// On ne sait pas a priori quelle couche du standard CNIG porte ces zones :
// elles sont recentes (loi Climat et Resilience, decret de 2022) et peuvent
// etre encodees en zone_urba, en prescription surfacique, en secteur de carte
// communale ou en info surfacique. Cet endpoint interroge donc TOUTES les
// couches et restitue les vocabulaires observes, afin de deduire la regle des
// donnees plutot que de la supposer. Meme methode que pour Georisques : un 404
// signale un nom de couche errone, non une absence de donnee.
//
// Note CORS : apicarto.ign.fr autorise l'appel navigateur (constate sur URBA).
// Le passage par une fonction serverless n'est donc pas indispensable ici ;
// il est retenu pour homogeneite avec /api/test et pour tracer les appels.
//
// Usage :
//   /api/gpu
//   /api/gpu?parcelle=62160-000-XM-0307
//   /api/gpu?couche=zone-urba
//   /api/gpu?insee=62160            (couches interrogeables par commune)

const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const IGN_GPU = 'https://apicarto.ign.fr/api/gpu';

const DEFAUTS = { parcelle: '62160-000-XM-0307', insee: '62160' };

// Couches du module GPU. Les noms sont ceux du standard CNIG tel qu'expose par
// API Carto ; ils restent A CONFIRMER par l'appel : un 404 vaut demonstration.
const COUCHES = {
  municipality:      { mode: 'geom', role: 'commune et regime applicable (RNU ou document)' },
  document:          { mode: 'geom', role: 'document d\'urbanisme applicable, partition, pieces ecrites' },
  'zone-urba':       { mode: 'geom', role: 'zonage : champ urlfic = lien du reglement' },
  'secteur-cc':      { mode: 'geom', role: 'secteurs de carte communale' },
  'prescription-surf': { mode: 'geom', role: 'prescriptions surfaciques — CANDIDAT trait de cote' },
  'prescription-lin':  { mode: 'geom', role: 'prescriptions lineaires' },
  'prescription-pct':  { mode: 'geom', role: 'prescriptions ponctuelles' },
  'info-surf':       { mode: 'geom', role: 'informations surfaciques — CANDIDAT trait de cote' },
  'info-lin':        { mode: 'geom', role: 'informations lineaires' },
  'info-pct':        { mode: 'geom', role: 'informations ponctuelles' },
  'acte-sup':        { mode: 'geom', role: 'actes instituant les servitudes' },
  'assiette-sup-s':  { mode: 'geom', role: 'assiettes de SUP surfaciques' },
  'assiette-sup-l':  { mode: 'geom', role: 'assiettes de SUP lineaires' },
  'assiette-sup-p':  { mode: 'geom', role: 'assiettes de SUP ponctuelles' },
  'generateur-sup-s': { mode: 'geom', role: 'generateurs de SUP surfaciques' },
  'generateur-sup-l': { mode: 'geom', role: 'generateurs de SUP lineaires' },
  'generateur-sup-p': { mode: 'geom', role: 'generateurs de SUP ponctuels' }
};

// Termes recherches dans les libelles restitues, pour reperer une eventuelle
// mention du recul du trait de cote quelle que soit la couche porteuse.
const INDICES = [
  'trait de cote', 'trait de côte', 'recul', 'erosion', 'érosion',
  'littoral', 'falaise', 'submersion', 'l121-22', 'l.121-22', 'prefiguration',
  'préfiguration', 'rtc'
];

export default async function handler(req, res) {
  const depart = Date.now();
  const parcelle = (req.query.parcelle || DEFAUTS.parcelle).toString();
  const insee = (req.query.insee || DEFAUTS.insee).toString();
  const demandee = req.query.couche ? req.query.couche.toString() : null;

  const socle = { horodatage: new Date().toISOString(), parametres: { parcelle, insee } };

  if (demandee && !COUCHES[demandee]) {
    return res.status(400).json({
      ...socle, resultat: 'ECHEC',
      cause: `Couche inconnue : ${demandee}`,
      couches_disponibles: Object.keys(COUCHES)
    });
  }

  // --- Etape 1 : geometrie de la parcelle --------------------------------
  const geo = await geometrieParcelle(parcelle);
  if (!geo.obtenu) {
    return res.status(200).json({
      ...socle, resultat: 'ECHEC',
      geometrie: geo,
      consequence: 'Sans geometrie, aucune couche GPU ne peut etre interrogee.'
    });
  }

  const aTester = demandee ? [demandee] : Object.keys(COUCHES);
  const resultats = {};
  for (const nom of aTester) {
    resultats[nom] = await interrogerCouche(nom, COUCHES[nom], geo.geometrie);
    if (aTester.length > 1) await pause(150);
  }

  // --- Synthese ---------------------------------------------------------
  const joignables = [];
  const inconnues = [];
  const avecDonnees = [];
  const pistes = [];

  for (const [nom, r] of Object.entries(resultats)) {
    if (r.code_http === 404) inconnues.push(nom);
    else if (r.code_http === 200) {
      joignables.push(nom);
      if (r.entites > 0) avecDonnees.push({ couche: nom, entites: r.entites });
      if (r.indices_trait_de_cote && r.indices_trait_de_cote.length) {
        pistes.push({ couche: nom, correspondances: r.indices_trait_de_cote });
      }
    }
  }

  return res.status(200).json({
    ...socle,
    resultat: inconnues.length ? 'PARTIEL' : 'SUCCES',
    geometrie: { obtenu: true, type: geo.geometrie.type, contenance_m2: geo.contenance },
    synthese: {
      couches_testees: aTester.length,
      joignables: joignables.length,
      noms_errones: inconnues,
      avec_donnees: avecDonnees,
      duree_totale_ms: Date.now() - depart
    },
    recul_trait_de_cote: {
      article: 'R.125-23 7°',
      pistes_reperees: pistes,
      lecture: pistes.length
        ? "Une ou plusieurs couches mentionnent le trait de cote : examiner les libelles pour etablir la regle de qualification."
        : "Aucune mention du trait de cote sur cette parcelle. Non concluant : la parcelle de test n'est peut-etre pas en zone. Rejouer sur une commune littorale dotee d'une carte de prefiguration."
    },
    couches: resultats
  });
}

// ---------------------------------------------------------------------------
async function geometrieParcelle(reference) {
  const m = reference.split('-');
  if (m.length !== 4) return { obtenu: false, cause: `Reference non decomposable : ${reference}` };
  const [codeInsee, comAbs, section, numero] = m;

  const url = `${IGN_CADASTRE}?code_insee=${codeInsee}&section=${section}&numero=${numero}&com_abs=${comAbs}&_limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = JSON.parse(await r.text());
    const t = Array.isArray(j.features) ? j.features : [];
    if (!t.length) return { obtenu: false, cause: 'Parcelle introuvable au cadastre IGN.', code_http: r.status };
    return {
      obtenu: true,
      geometrie: t[0].geometry,
      contenance: t[0].properties ? t[0].properties.contenance : null
    };
  } catch (e) {
    return { obtenu: false, cause: e.message };
  }
}

async function interrogerCouche(nom, cfg, geometrie) {
  // API Carto attend la geometrie GeoJSON encodee dans le parametre geom.
  const params = new URLSearchParams();
  params.set('geom', JSON.stringify(geometrie));
  params.set('_limit', '100');

  const url = `${IGN_GPU}/${nom}?${params.toString()}`;
  const t0 = Date.now();

  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const txt = await r.text();

    let j = null;
    try { j = JSON.parse(txt); }
    catch {
      return {
        role: cfg.role, code_http: r.status, duree_ms: Date.now() - t0,
        lecture: interpreter(r.status), reponse_non_json: txt.slice(0, 250)
      };
    }

    const traits = Array.isArray(j.features) ? j.features : [];
    const out = {
      role: cfg.role,
      code_http: r.status,
      lecture: interpreter(r.status),
      entites: traits.length,
      duree_ms: Date.now() - t0
    };
    if (r.status !== 200) {
      out.message = j.message || j.error || null;
      return out;
    }

    // Vocabulaire observe : noms de champs et valeurs textuelles distinctes.
    if (traits.length) {
      out.champs = Object.keys(traits[0].properties || {});
      out.echantillon = traits.slice(0, 5).map(f => resumer(f.properties));

      const valeurs = new Set();
      for (const f of traits) {
        for (const v of Object.values(f.properties || {})) {
          if (typeof v === 'string' && v.length && v.length < 120) valeurs.add(v);
        }
      }
      out.valeurs_distinctes = Array.from(valeurs).slice(0, 40);

      const trouves = Array.from(valeurs).filter(v =>
        INDICES.some(i => v.toLowerCase().includes(i))
      );
      if (trouves.length) out.indices_trait_de_cote = trouves;
    }

    return out;

  } catch (e) {
    return { role: cfg.role, code_http: 0, lecture: "L'appel a echoue avant reponse.",
             detail: e.message, duree_ms: Date.now() - t0 };
  }
}

// Ne conserve que les champs utiles a la lecture, pour ne pas noyer la reponse.
function resumer(p) {
  if (!p) return null;
  const garde = [
    'libelle', 'libelong', 'typezone', 'typepsc', 'typeinf', 'nomfic', 'urlfic',
    'partition', 'idurba', 'typedoc', 'datappro', 'insee', 'nom', 'idsup',
    'txt', 'destdomi', 'stypepsc', 'stypeinf'
  ];
  const out = {};
  for (const k of Object.keys(p)) {
    if (garde.includes(k.toLowerCase())) out[k] = p[k];
  }
  return Object.keys(out).length ? out : p;
}

function interpreter(c) {
  if (c === 200) return 'OK';
  if (c === 400) return 'Parametres invalides (geometrie mal formee ?).';
  if (c === 404) return 'Couche inconnue : le nom est errone.';
  if (c === 429) return 'Quota depasse.';
  if (c >= 500) return 'Erreur cote API Carto.';
  return `Code inattendu : ${c}`;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
