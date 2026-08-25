// RISQUES — /api/gpu.js
//
// Interrogation du Geoportail de l'urbanisme via le module GPU d'API Carto,
// avec qualification par codes CNIG.
//
// SOURCE DES CODES
// Standard CNIG PLU v2024 rev. 2025-06 (millesime PrescriptionUrbaType 2025-06,
// millesime InformationUrbaType 2022-06), publie sur le GPU. Les codes ci-dessous
// sont releves dans les tables PrescriptionUrbaType et InformationUrbaType.
//
// CE QUI RELEVE DE R.125-23
//   7° recul du trait de cote :
//      - PRESCRIPTION 54-01 : zone exposee a l'horizon de trente ans (L121-22-2)
//      - PRESCRIPTION 54-02 : zone exposee entre trente et cent ans (L121-22-2)
//      - carte de prefiguration : INFORMATION surfacique, TYPEINF 99 / STYPEINF 00,
//        reconnaissable au seul TXT "pre-ZERTC" ou au libelle. Convention fragile,
//        signalee comme telle dans la restitution.
//        Elle s'applique tant que les ZERTC ne sont pas en vigueur et a defaut de
//        PPR littoral approuve comportant des dispositions sur le trait de cote.
//   8° debroussaillement : INFORMATION 43-00, en complement de /api/v2/old
//
// AUTRES REGIMES (addendum v9, section 3)
//   L.125-7 pollution des sols : INFORMATION 38-00 (secteurs d'information sur les sols)
//   code de l'urbanisme, bruit  : INFORMATION 27-00 (plan d'exposition au bruit)
//
// PIEGE CONSIGNE (addendum v14)
//   La couche acte-sup IGNORE la geometrie et retourne un catalogue national
//   plafonne a 5000 entites. Elle n'est plus interrogee.
//
// Usage :
//   /api/gpu
//   /api/gpu?parcelle=62160-000-XM-0307
//   /api/gpu?couche=prescription-surf

const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const IGN_GPU = 'https://apicarto.ign.fr/api/gpu';

const DEFAUTS = { parcelle: '62160-000-XM-0307' };

const COUCHES = {
  municipality:       { role: 'commune : is_rnu et is_coastline' },
  document:           { role: "document d'urbanisme applicable et partition" },
  'zone-urba':        { role: 'zonage reglementaire' },
  'secteur-cc':       { role: 'secteurs de carte communale' },
  'prescription-surf': { role: 'prescriptions surfaciques — porte 54-01 et 54-02' },
  'prescription-lin':  { role: 'prescriptions lineaires' },
  'prescription-pct':  { role: 'prescriptions ponctuelles' },
  'info-surf':        { role: 'informations surfaciques — porte 27-00, 38-00, 43-00 et pre-ZERTC' },
  'info-lin':         { role: 'informations lineaires' },
  'info-pct':         { role: 'informations ponctuelles' },
  'assiette-sup-s':   { role: 'assiettes de SUP surfaciques' },
  'assiette-sup-l':   { role: 'assiettes de SUP lineaires' },
  'assiette-sup-p':   { role: 'assiettes de SUP ponctuelles' },
  'generateur-sup-s': { role: 'generateurs de SUP surfaciques' },
  'generateur-sup-l': { role: 'generateurs de SUP lineaires' },
  'generateur-sup-p': { role: 'generateurs de SUP ponctuels' }
  // acte-sup volontairement absente : ne filtre pas sur l'emprise (addendum v14).
};

// Prescriptions relevant de l'etat des risques.
const PRESCRIPTIONS_ERP = {
  '54-01': { article: 'R.125-23 7°', libelle: "Zone exposee au recul du trait de cote a l'horizon de trente ans", visa: 'L121-22-2' },
  '54-02': { article: 'R.125-23 7°', libelle: 'Zone exposee au recul du trait de cote entre trente et cent ans', visa: 'L121-22-2' }
};

// Informations relevant de l'etat des risques ou des regimes connexes.
const INFORMATIONS_ERP = {
  '43-00': { article: 'R.125-23 8°', libelle: "Secteur d'obligation legale de debroussaillement", regime: 'IAL' },
  '38-00': { article: 'L.125-6 et L.125-7', libelle: "Secteur d'information sur les sols", regime: 'pollution des sols' },
  '27-00': { article: 'code de l\'urbanisme L112-6', libelle: "Plan d'exposition au bruit des aerodromes", regime: 'nuisances sonores aeriennes' },
  '21-00': { article: 'contexte', libelle: 'Projet de plan de prevention des risques', regime: 'information' },
  '14-00': { article: 'contexte', libelle: "Secteur affecte par le bruit d'une infrastructure terrestre", regime: 'information' },
  '17-00': { article: 'contexte', libelle: "Zone a risque d'exposition au plomb", regime: 'information' }
};

export default async function handler(req, res) {
  const depart = Date.now();
  const parcelle = (req.query.parcelle || DEFAUTS.parcelle).toString();
  const demandee = req.query.couche ? req.query.couche.toString() : null;

  const socle = { horodatage: new Date().toISOString(), parametres: { parcelle } };

  if (demandee && !COUCHES[demandee]) {
    return res.status(400).json({
      ...socle, resultat: 'ECHEC',
      cause: `Couche inconnue ou volontairement exclue : ${demandee}`,
      couches_disponibles: Object.keys(COUCHES)
    });
  }

  const geo = await geometrieParcelle(parcelle);
  if (!geo.obtenu) {
    return res.status(200).json({ ...socle, resultat: 'ECHEC', geometrie: geo });
  }

  const aTester = demandee ? [demandee] : Object.keys(COUCHES);
  const resultats = {};
  for (const nom of aTester) {
    resultats[nom] = await interroger(nom, COUCHES[nom], geo.geometrie);
    if (aTester.length > 1) await pause(150);
  }

  return res.status(200).json({
    ...socle,
    resultat: 'SUCCES',
    geometrie: { type: geo.geometrie.type, contenance_m2: geo.contenance },
    commune: lireCommune(resultats.municipality),
    document: lireDocument(resultats.document),
    etat_des_risques: qualifier(resultats),
    synthese: {
      couches_testees: aTester.length,
      duree_totale_ms: Date.now() - depart
    },
    couches: resultats
  });
}

// ---------------------------------------------------------------------------
function qualifier(r) {
  const corps = [];
  const regimes_connexes = [];
  const alertes = [];

  // --- 7° : prescriptions 54-01 et 54-02 --------------------------------
  const pres = collecter(r, ['prescription-surf', 'prescription-lin', 'prescription-pct']);
  for (const p of pres) {
    const code = `${pad(p.typepsc)}-${pad(p.stypepsc)}`;
    const ref = PRESCRIPTIONS_ERP[code];
    if (ref) {
      corps.push({
        code_cnig: code, article: ref.article, libelle: ref.libelle,
        visa: ref.visa, texte_local: p.libelle || null, etiquette: p.txt || null,
        fichier: p.nomfic || null, lien: p.urlfic || null
      });
    }
  }

  // --- Informations : 43-00, 38-00, 27-00 et contexte -------------------
  const infos = collecter(r, ['info-surf', 'info-lin', 'info-pct']);
  for (const i of infos) {
    const code = `${pad(i.typeinf)}-${pad(i.stypeinf)}`;
    const ref = INFORMATIONS_ERP[code];
    if (ref && ref.regime === 'IAL') {
      corps.push({
        code_cnig: code, article: ref.article, libelle: ref.libelle,
        texte_local: i.libelle || null, etiquette: i.txt || null
      });
    } else if (ref) {
      regimes_connexes.push({
        code_cnig: code, regime: ref.regime, article: ref.article,
        libelle: ref.libelle, texte_local: i.libelle || null, etiquette: i.txt || null
      });
    }

    // --- Carte de prefiguration : convention par libelle, non par code ---
    const txt = (i.txt || '').toLowerCase();
    const lib = (i.libelle || '').toLowerCase();
    if (txt.includes('pre-zertc') || lib.includes('prefiguration des zones exposees au recul')
        || lib.includes('préfiguration des zones exposées au recul')) {
      corps.push({
        code_cnig: `${pad(i.typeinf)}-${pad(i.stypeinf)}`,
        article: 'R.125-23 7°',
        libelle: 'Carte de prefiguration des zones exposees au recul du trait de cote',
        texte_local: i.libelle || null, etiquette: i.txt || null,
        avertissement: "Detectee par libelle et non par code : le standard impose TYPEINF 99 / STYPEINF 00, code generique. Verification humaine recommandee."
      });
    }
  }

  // --- Alertes de methode ------------------------------------------------
  const com = premier(r.municipality);
  if (com && com.is_coastline === true) {
    const aTraitDeCote = corps.some(c => c.article === 'R.125-23 7°');
    if (!aTraitDeCote) {
      alertes.push("Commune littorale (is_coastline vrai) sans zone de recul du trait de cote delimitee. Verifier si la commune figure au decret du 29 avril 2022 modifie : l'inscription au decret ne vaut pas delimitation, mais l'absence de delimitation peut aussi traduire un document d'urbanisme non encore actualise.");
    }
  }
  if (com && com.is_rnu === true) {
    alertes.push("Commune au reglement national d'urbanisme : l'absence de document d'urbanisme ne signifie pas absence de regle.");
  }
  if (!r.document || !premier(r.document)) {
    alertes.push("Aucun document d'urbanisme publie sur le GPU pour cette parcelle. Une absence sur le GPU ne prouve pas l'absence de document opposable : il peut ne pas etre dematerialise.");
  }

  return { corps, regimes_connexes, alertes };
}

function collecter(r, couches) {
  const out = [];
  for (const c of couches) {
    const bloc = r[c];
    if (bloc && Array.isArray(bloc.entites_detail)) out.push(...bloc.entites_detail);
  }
  return out;
}

function premier(bloc) {
  return bloc && Array.isArray(bloc.entites_detail) && bloc.entites_detail.length
    ? bloc.entites_detail[0] : null;
}

function pad(v) {
  if (v === null || v === undefined || v === '') return '00';
  const s = String(v);
  return s.length === 1 ? '0' + s : s;
}

function lireCommune(bloc) {
  const c = premier(bloc);
  if (!c) return null;
  return { insee: c.insee, nom: c.name, rnu: c.is_rnu, littorale: c.is_coastline };
}

function lireDocument(bloc) {
  const d = premier(bloc);
  if (!d) return null;
  return {
    type: d.du_type, nom: d.grid_title, partition: d.partition,
    statut: d.gpu_status, horodatage: d.gpu_timestamp,
    rappel: "Pour le reglement, appeler /api/document/{id}/details et lire archiveUrl. Ne jamais utiliser document/info/?partition=."
  };
}

// ---------------------------------------------------------------------------
async function geometrieParcelle(reference) {
  const m = reference.split('-');
  if (m.length !== 4) return { obtenu: false, cause: `Reference non decomposable : ${reference}` };
  const [insee, comAbs, section, numero] = m;
  const url = `${IGN_CADASTRE}?code_insee=${insee}&section=${section}&numero=${numero}&com_abs=${comAbs}&_limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = JSON.parse(await r.text());
    const t = Array.isArray(j.features) ? j.features : [];
    if (!t.length) return { obtenu: false, cause: 'Parcelle introuvable au cadastre IGN.', code_http: r.status };
    return { obtenu: true, geometrie: t[0].geometry, contenance: (t[0].properties || {}).contenance };
  } catch (e) {
    return { obtenu: false, cause: e.message };
  }
}

async function interroger(nom, cfg, geometrie) {
  const params = new URLSearchParams();
  params.set('geom', JSON.stringify(geometrie));
  params.set('_limit', '500');
  const url = `${IGN_GPU}/${nom}?${params.toString()}`;
  const t0 = Date.now();

  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); }
    catch {
      return { role: cfg.role, code_http: r.status, duree_ms: Date.now() - t0,
               reponse_non_json: txt.slice(0, 250) };
    }
    const traits = Array.isArray(j.features) ? j.features : [];
    const out = {
      role: cfg.role,
      code_http: r.status,
      lecture: interpreter(r.status),
      entites: traits.length,
      duree_ms: Date.now() - t0,
      entites_detail: traits.map(f => f.properties || {})
    };
    // Codes CNIG observes, pour lecture rapide.
    if (traits.length) {
      const codes = new Set();
      for (const p of out.entites_detail) {
        if (p.typepsc !== undefined) codes.add(`PSC ${pad(p.typepsc)}-${pad(p.stypepsc)}`);
        if (p.typeinf !== undefined) codes.add(`INF ${pad(p.typeinf)}-${pad(p.stypeinf)}`);
      }
      if (codes.size) out.codes_cnig = Array.from(codes);
    }
    return out;
  } catch (e) {
    return { role: cfg.role, code_http: 0, detail: e.message, duree_ms: Date.now() - t0 };
  }
}

function interpreter(c) {
  if (c === 200) return 'OK';
  if (c === 400) return 'Parametres invalides.';
  if (c === 404) return 'Couche inconnue.';
  if (c >= 500) return 'Erreur cote API Carto.';
  return `Code inattendu : ${c}`;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
