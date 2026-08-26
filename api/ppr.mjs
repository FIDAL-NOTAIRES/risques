// RISQUES — /api/ppr.mjs
//
// Recherche du cas positif de zoneRegExists.
//
// POURQUOI CET ENDPOINT
// Le champ zonageReglementaire.zoneRegExists est le discriminant de
// l'obligation d'information pour les 1° a 4° de R.125-23 : la seule presence
// d'une procedure de PPR sur la commune ne suffit pas, il faut que le bien soit
// dans une ZONE DELIMITEE (addendum v11, section 5).
//
// Cette regle n'a ete eprouvee que dans son cas NEGATIF : sur la parcelle de
// Boulogne-sur-Mer, deux procedures de PPRN existent mais zoneRegExists vaut
// faux, et l'ERRIAL officiel confirme en n'en mentionnant aucune. Le cas
// positif reste theorique. Or cette regle pilote six des huit items du corps
// de l'etat des risques : elle ne peut pas rester a moitie verifiee.
//
// DEUX VOIES, MENEES ENSEMBLE
//   mode=parcelles : interroge une liste de parcelles nommees
//   mode=communes  : interroge des communes par code INSEE, ce qui indique
//                    ou chercher ensuite une parcelle
//
// Usage :
//   /api/ppr                                  les deux modes, jeu par defaut
//   /api/ppr?mode=communes&insee=37261,41018
//   /api/ppr?mode=parcelles&parcelle=59009-000-NL-0113
//   /api/ppr?mode=parcelles                   jeu de parcelles par defaut

const BASE = 'https://www.georisques.gouv.fr';

// Parcelles du dossier 0042 (Villeneuve-d'Ascq), deja utilisees pour valider
// le gabarit de TRENTE. Format v2 : INSEE-PREFIXE-SECTION-NUMERO.
const PARCELLES = [
  { ref: '59009-000-NL-0113', note: 'dossier 0042, Villeneuve-d\'Ascq NL113' },
  { ref: '59009-000-NL-0117', note: 'dossier 0042, Villeneuve-d\'Ascq NL117' },
  { ref: '59009-000-NL-0294', note: 'dossier 0042, Villeneuve-d\'Ascq NL294' }
];

// Communes retenues pour leur exposition notoire a un PPR inondation approuve
// de longue date. Choix a eprouver, non a croire.
const COMMUNES = [
  { insee: '37261', nom: 'Tours (37)' },
  { insee: '41018', nom: 'Blois (41)' },
  { insee: '45234', nom: 'Orleans (45)' },
  { insee: '59009', nom: "Villeneuve-d'Ascq (59)" },
  { insee: '30189', nom: 'Nimes (30)' },
  { insee: '13001', nom: 'Aix-en-Provence (13)' },
  { insee: '33063', nom: 'Bordeaux (33)' },
  { insee: '76540', nom: 'Rouen (76)' }
];

const FAMILLES = ['pprn', 'pprt', 'pprm'];

export default async function handler(req, res) {
  const debut = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;
  const mode = req.query.mode ? req.query.mode.toString() : 'les_deux';

  if (!jeton) {
    return res.status(500).json({
      resultat: 'ECHEC',
      cause: "Variable d'environnement GEORISQUES_TOKEN absente."
    });
  }

  const sortie = {
    horodatage: new Date().toISOString(),
    objet: "Eprouver zoneRegExists dans son cas positif (R.125-23, 1° a 4°)",
    mode
  };

  // --- Voie 1 : parcelles nommees ---------------------------------------
  if (mode === 'parcelles' || mode === 'les_deux') {
    const liste = req.query.parcelle
      ? req.query.parcelle.toString().split(',').map(s => ({ ref: s.trim(), note: 'fournie en parametre' }))
      : PARCELLES;

    const resultats = [];
    for (const p of liste) {
      resultats.push(await examinerParcelle(p, jeton));
      await pause(130);
    }
    sortie.parcelles = resultats;
  }

  // --- Voie 2 : communes ------------------------------------------------
  if (mode === 'communes' || mode === 'les_deux') {
    const liste = req.query.insee
      ? req.query.insee.toString().split(',').map(s => ({ insee: s.trim(), nom: s.trim() }))
      : COMMUNES;

    const resultats = [];
    for (const c of liste) {
      resultats.push(await examinerCommune(c, jeton));
      await pause(130);
    }
    sortie.communes = resultats;
  }

  // --- Synthese ---------------------------------------------------------
  const positifs = [];
  for (const bloc of [sortie.parcelles || [], sortie.communes || []]) {
    for (const r of bloc) {
      if (r.zones_delimitees && r.zones_delimitees.length) {
        positifs.push({
          cible: r.reference || r.insee,
          libelle: r.note || r.nom,
          plans: r.zones_delimitees
        });
      }
    }
  }

  sortie.cas_positifs = positifs;
  sortie.lecture = positifs.length
    ? "zoneRegExists vaut VRAI sur au moins une cible : la regle est desormais eprouvee dans ses deux cas. Si le positif porte sur une commune et non une parcelle, descendre a la parcelle pour verifier la qualification complete."
    : "Aucun cas positif. Les procedures trouvees existent sur la commune mais sans zone delimitee couvrant la cible. Elargir avec ?insee= ou ?parcelle=.";
  sortie.duree_totale_ms = Date.now() - debut;

  return res.status(200).json(sortie);
}

// ---------------------------------------------------------------------------
async function examinerParcelle(p, jeton) {
  const out = { reference: p.ref, note: p.note, familles: {}, zones_delimitees: [] };

  for (const f of FAMILLES) {
    const r = await interroger(f, { codesParcelle: p.ref }, jeton);
    out.familles[f] = resumer(r);
    if (r.ok) collecterZones(f, r.items, out.zones_delimitees);
    await pause(110);
  }
  out.qualification = conclure(out);
  return out;
}

async function examinerCommune(c, jeton) {
  const out = { insee: c.insee, nom: c.nom, familles: {}, zones_delimitees: [] };

  for (const f of FAMILLES) {
    const r = await interroger(f, { codesInsee: c.insee }, jeton);
    out.familles[f] = resumer(r);
    if (r.ok) collecterZones(f, r.items, out.zones_delimitees);
    await pause(110);
  }
  out.qualification = conclure(out);
  return out;
}

function collecterZones(famille, items, cible) {
  for (const e of items) {
    const z = e.zonageReglementaire;
    if (z && z.zoneRegExists === true) {
      cible.push({
        famille,
        idGaspar: e.idGaspar || null,
        libelle: e.libPpr || null,
        modele: e.modeleProcedure || null,
        bassin: e.libBassinRisques || null,
        en_revision: e.etatRevision,
        sup_existe: e.supExists,
        zones: (z.listTypeReg || []).map(t => ({
          code: t.code || null, codeZone: t.codeZone || null,
          libelle: t.libelle || null, nom: t.nom || null
        })),
        date_modification: e.dateModification || null
      });
    }
  }
}

function conclure(out) {
  const total = FAMILLES.reduce((a, f) => a + (out.familles[f].total || 0), 0);
  if (!total) {
    return { retenu: false, motif: 'aucune procedure de PPR sur cette cible' };
  }
  if (!out.zones_delimitees.length) {
    return {
      retenu: false,
      motif: `${total} procedure(s) trouvee(s), mais aucune zone delimitee couvrant la cible (zoneRegExists faux)`,
      lecture: "Ne figure PAS au corps de l'etat des risques."
    };
  }
  return {
    retenu: true,
    motif: `${out.zones_delimitees.length} plan(s) avec zone delimitee applicable`,
    lecture: "Figure au corps de l'etat des risques. R.125-24 exige alors : extrait du document graphique situant le bien par rapport au zonage, extrait du reglement le concernant, et information sur les travaux prescrits et leur realisation.",
    documents: out.zones_delimitees.map(z =>
      `/api/v2/gaspar/${z.famille}/${z.idGaspar}/documents`)
  };
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
      return { ok: false, url, code_http: r.status, items: [], extrait: txt.slice(0, 200) };
    }
    const j = JSON.parse(txt);
    const items = Array.isArray(j.content) ? j.content : [];
    return { ok: true, url, code_http: 200, total: j.totalElements, items };
  } catch (e) {
    return { ok: false, url, code_http: 0, items: [], detail: e.message };
  }
}

function resumer(r) {
  const out = { code_http: r.code_http, total: r.total ?? 0 };
  if (!r.ok) { out.erreur = r.extrait || r.detail || null; return out; }
  out.procedures = r.items.map(e => ({
    idGaspar: e.idGaspar,
    libelle: e.libPpr,
    en_zone: e.zonageReglementaire ? e.zonageReglementaire.zoneRegExists : null,
    nb_zones: ((e.zonageReglementaire || {}).listTypeReg || []).length
  }));
  return out;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
