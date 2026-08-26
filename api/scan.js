// RISQUES — /api/scan.js
//
// Balayage de communes littorales a la recherche d'une prescription
// 54-01 ou 54-02 (zone exposee au recul du trait de cote), ou d'une carte
// de prefiguration (pre-ZERTC).
//
// OBJET
// La regle de qualification du 7° de R.125-23 est etablie et sourcee au
// standard CNIG (addendum v15), mais n'a jamais ete verifiee sur donnee
// reelle : aucune parcelle testee n'etait en zone. Cet endpoint cherche une
// commune de recette.
//
// METHODE ET SA LIMITE ASSUMEE
// Le module GPU s'interroge par geometrie passee en parametre d'URL. Une
// geometrie communale complete depasse la longueur admissible d'une URL. On
// interroge donc avec le RECTANGLE ENGLOBANT de la commune, ce qui constitue
// un sur-ensemble : des prescriptions de communes voisines peuvent etre
// captees. C'est sans consequence ici, l'objet etant de DETECTER une commune
// candidate, non de qualifier un bien. La qualification se fera ensuite sur
// parcelle, via /api/gpu.
//
// Les codes INSEE par defaut ci-dessous sont des CANDIDATS choisis parmi des
// communes littorales connues pour leur exposition a l'erosion. Leur presence
// au decret du 29 avril 2022 modifie n'a PAS ete verifiee, et l'inscription au
// decret ne vaut de toute facon pas delimitation. La liste est a eprouver, non
// a croire.
//
// Usage :
//   /api/scan
//   /api/scan?insee=33214,33544,50213
//   /api/scan?insee=85113

const IGN_COMMUNE = 'https://apicarto.ign.fr/api/cadastre/commune';
const IGN_GPU = 'https://apicarto.ign.fr/api/gpu';

// Candidats : communes littorales exposees a l'erosion, toutes facades.
const CANDIDATS = [
  { insee: '33214', nom: 'Lacanau (33)' },
  { insee: '33544', nom: 'Soulac-sur-Mer (33)' },
  { insee: '40046', nom: 'Biscarrosse (40)' },
  { insee: '40065', nom: 'Capbreton (40)' },
  { insee: '50213', nom: 'Gouville-sur-Mer (50)' },
  { insee: '76194', nom: 'Criel-sur-Mer (76)' },
  { insee: '80039', nom: 'Ault (80)' },
  { insee: '34333', nom: 'Vias (34)' },
  { insee: '66017', nom: 'Le Barcares (66)' },
  { insee: '56233', nom: 'Saint-Pierre-Quiberon (56)' },
  { insee: '85113', nom: "Notre-Dame-de-Monts (85)" },
  { insee: '17140', nom: "La Couarde-sur-Mer (17)" }
];

const CODES_CIBLE = ['54-01', '54-02'];

export default async function handler(req, res) {
  const depart = Date.now();

  const liste = req.query.insee
    ? req.query.insee.toString().split(',').map(s => ({ insee: s.trim(), nom: s.trim() }))
    : CANDIDATS;

  const resultats = [];
  const trouvees = [];

  for (const c of liste) {
    const r = await examiner(c);
    resultats.push(r);
    if (r.zones_trait_de_cote && r.zones_trait_de_cote.length) trouvees.push(r);
    await pause(200);
  }

  return res.status(200).json({
    horodatage: new Date().toISOString(),
    methode: {
      interrogation: 'rectangle englobant de la commune (limite de longueur d\'URL)',
      consequence: 'sur-ensemble possible : des prescriptions voisines peuvent etre captees',
      suite: 'qualifier ensuite sur parcelle via /api/gpu'
    },
    synthese: {
      communes_examinees: resultats.length,
      avec_zone_trait_de_cote: trouvees.length,
      duree_totale_ms: Date.now() - depart
    },
    communes_de_recette: trouvees.map(t => ({
      insee: t.insee, nom: t.nom,
      codes: t.zones_trait_de_cote.map(z => z.code),
      libelles: t.zones_trait_de_cote.map(z => z.libelle)
    })),
    lecture: trouvees.length
      ? "Au moins une commune porte une zone de recul du trait de cote. Identifier une parcelle dans cette zone, puis appeler /api/gpu?parcelle=... pour eprouver la qualification dans son cas positif."
      : "Aucune des communes examinees ne porte de zone 54-01 ou 54-02 publiee sur le GPU. Non concluant : soit ces communes ne figurent pas au decret, soit leur document d'urbanisme n'a pas encore integre la cartographie. Elargir la liste avec ?insee=",
    detail: resultats
  });
}

async function examiner(c) {
  const t0 = Date.now();

  // --- Rectangle englobant de la commune --------------------------------
  const bbox = await rectangleCommune(c.insee);
  if (!bbox.obtenu) {
    return { insee: c.insee, nom: c.nom, obtenu: false, cause: bbox.cause, duree_ms: Date.now() - t0 };
  }

  const sortie = {
    insee: c.insee,
    nom: bbox.nom || c.nom,
    obtenu: true,
    prescriptions_surfaciques: 0,
    codes_observes: [],
    zones_trait_de_cote: [],
    prefiguration: [],
    duree_ms: 0
  };

  // --- Prescriptions surfaciques ----------------------------------------
  const pres = await couche('prescription-surf', bbox.polygone);
  if (pres.ok) {
    sortie.prescriptions_surfaciques = pres.items.length;
    const codes = new Set();
    for (const p of pres.items) {
      const code = `${pad(p.typepsc)}-${pad(p.stypepsc)}`;
      codes.add(code);
      if (CODES_CIBLE.includes(code)) {
        sortie.zones_trait_de_cote.push({
          code,
          libelle: p.libelle || null,
          etiquette: p.txt || null,
          nature: p.nature || null,
          idurba: p.idurba || null,
          fichier: p.nomfic || null
        });
      }
    }
    sortie.codes_observes = Array.from(codes).sort();
  } else {
    sortie.erreur_prescriptions = pres.cause;
  }

  // --- Carte de prefiguration : information surfacique, code generique --
  const infos = await couche('info-surf', bbox.polygone);
  if (infos.ok) {
    for (const i of infos.items) {
      const txt = (i.txt || '').toLowerCase();
      const lib = normaliser(i.libelle || '');
      if (txt.includes('pre-zertc') || lib.includes('prefiguration')) {
        sortie.prefiguration.push({
          code: `${pad(i.typeinf)}-${pad(i.stypeinf)}`,
          libelle: i.libelle || null,
          etiquette: i.txt || null,
          avertissement: 'reconnaissance par libelle, non par code'
        });
      }
    }
  } else {
    sortie.erreur_informations = infos.cause;
  }

  sortie.duree_ms = Date.now() - t0;
  return sortie;
}

// ---------------------------------------------------------------------------
async function rectangleCommune(insee) {
  const url = `${IGN_COMMUNE}?code_insee=${insee}&_limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = JSON.parse(await r.text());
    const t = Array.isArray(j.features) ? j.features : [];
    if (!t.length) return { obtenu: false, cause: `Commune ${insee} introuvable au cadastre IGN.` };

    const pts = [];
    const parcourir = (x) => {
      if (!Array.isArray(x)) return;
      if (typeof x[0] === 'number' && typeof x[1] === 'number') { pts.push(x); return; }
      x.forEach(parcourir);
    };
    parcourir(t[0].geometry.coordinates);
    if (!pts.length) return { obtenu: false, cause: 'Geometrie communale illisible.' };

    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const x1 = Math.min(...xs), x2 = Math.max(...xs);
    const y1 = Math.min(...ys), y2 = Math.max(...ys);

    return {
      obtenu: true,
      nom: (t[0].properties || {}).nom || null,
      polygone: {
        type: 'Polygon',
        coordinates: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]]
      }
    };
  } catch (e) {
    return { obtenu: false, cause: e.message };
  }
}

async function couche(nom, geometrie) {
  const params = new URLSearchParams();
  params.set('geom', JSON.stringify(geometrie));
  params.set('_limit', '500');
  try {
    const r = await fetch(`${IGN_GPU}/${nom}?${params.toString()}`,
                          { headers: { Accept: 'application/json' } });
    const txt = await r.text();
    if (r.status !== 200) return { ok: false, cause: `HTTP ${r.status}` };
    const j = JSON.parse(txt);
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
