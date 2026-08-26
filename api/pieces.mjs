// RISQUES — /api/pieces.mjs
//
// Exploration des documents de plan de prevention, prealable a leur annexion
// automatique a l'etat des risques.
//
// CE QU'EXIGE R.125-24
// Pour chaque plan de prevention des 1° a 4° de R.125-23 couvrant le bien :
//   1. un extrait du document graphique situant le bien par rapport au zonage ;
//   2. l'extrait du reglement LE CONCERNANT ;
//   3. l'indication des travaux prescrits et de leur realisation (declaratif).
//
// Le point 2 est le plus exigeant : il ne s'agit pas du reglement entier mais
// de la partie applicable au bien. Or nous connaissons desormais le codeZone
// applicable (addendum v17), ce qui rend le reperage possible.
//
// POURQUOI EXPLORER AVANT DE CODER
// Deux endpoints existent : /documents rend une archive zip, /documents/{uuid}
// un PDF unitaire. Mais on ignore ce que contient reellement l'archive, comment
// les pieces sont typees, et si la liste est obtenable sans telecharger le zip.
// Le modele PprDocumentDto annonce type, titre et uuidDocument : la reponse
// detaillee du plan devrait donc suffire a lister. A verifier avant d'ecrire
// la fusion, plutot que de deviner comme pour les noms de couches.
//
// La parcelle de test de Boulogne n'etant dans aucune zone de PPR delimitee,
// les identifiants utilises ici proviennent des cas positifs etablis a
// l'addendum v17.
//
// Usage :
//   /api/pieces                                  jeu de plans par defaut
//   /api/pieces?ppr=pprn:37DDT20120007
//   /api/pieces?ppr=pprt:76DDTM20150002&telecharger=1
//   /api/pieces?ppr=pprn:41DDT20100001&uuid=...  inspecte une piece

const GEO = 'https://www.georisques.gouv.fr';

// Plans porteurs d'une zone delimitee, releves a l'addendum v17.
const PLANS = [
  { famille: 'pprn', id: '37DDT20120007',  note: 'PPRI Val de Tours - Val de Luynes' },
  { famille: 'pprn', id: '41DDT20100001',  note: 'Révision du PPRI de Blois' },
  { famille: 'pprt', id: '76DDTM20150002', note: 'Rouen Lubrizol' },
  { famille: 'pprn', id: '59DDTM20140002', note: 'PPR Marque, Villeneuve-d\'Ascq' }
];

export default async function handler(req, res) {
  const debut = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;
  if (!jeton) {
    return res.status(500).json({ resultat: 'ECHEC', cause: 'GEORISQUES_TOKEN absente.' });
  }

  let liste = PLANS;
  if (req.query.ppr) {
    const [famille, id] = req.query.ppr.toString().split(':');
    if (!famille || !id || !['pprn', 'pprt', 'pprm'].includes(famille)) {
      return res.status(400).json({
        resultat: 'ECHEC',
        cause: 'Format attendu : ?ppr=famille:idGaspar, famille parmi pprn, pprt, pprm',
        exemple: '/api/pieces?ppr=pprn:37DDT20120007'
      });
    }
    liste = [{ famille, id, note: 'fourni en paramètre' }];
  }

  const resultats = [];
  for (const p of liste) {
    resultats.push(await explorer(p, jeton, req.query.telecharger === '1'));
    await pause(150);
  }

  // Vocabulaire des types de pieces observes, toutes familles confondues.
  const types = new Map();
  for (const r of resultats) {
    for (const d of (r.documents || [])) {
      const t = d.type || '(sans type)';
      types.set(t, (types.get(t) || 0) + 1);
    }
  }

  return res.status(200).json({
    horodatage: new Date().toISOString(),
    objet: "Inventaire des pièces documentaires des plans de prévention (R.125-24)",
    synthese: {
      plans_examines: resultats.length,
      avec_documents: resultats.filter(r => (r.documents || []).length).length,
      duree_totale_ms: Date.now() - debut
    },
    types_de_pieces_observes: Array.from(types.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => ({ type, occurrences: n })),
    lecture: types.size
      ? "Les pièces sont listées avec leur type et leur identifiant : l'annexion peut donc être sélective, en ne retenant que le document graphique et le règlement, sans télécharger l'archive entière."
      : "Aucune pièce listée. Vérifier si l'archive /documents est le seul accès, auquel cas il faudra la télécharger et l'ouvrir pour connaître son contenu.",
    detail: resultats
  });
}

async function explorer(p, jeton, telecharger) {
  const out = { famille: p.famille, idGaspar: p.id, note: p.note };

  // --- Detail du plan : c'est lui qui devrait porter la liste des pieces ---
  const detail = await appel(`/api/v2/gaspar/${p.famille}/${p.id}`, jeton);
  out.detail_plan = { code_http: detail.code };

  if (detail.ok && detail.json) {
    const j = detail.json;
    out.libelle = j.libPpr || null;
    out.modele = j.modeleProcedure || null;
    out.revision = j.etatRevision;
    out.communes = (j.communes || []).length;

    // Les aleas portes par le plan, avec leurs dates de prescription et
    // d'approbation : utile pour distinguer le 4° (plan prescrit) du 2°.
    const premiere = (j.communes || [])[0];
    if (premiere) {
      out.aleas = (premiere.aleas || []).map(a => ({
        libelle: a.libelle,
        prescription: a.datePrescription || null,
        approbation: a.dateApprobation || null,
        abrogation: a.dateAbrog || null
      }));
      out.lien_ppr = premiere.lienPpr || null;
      out.etat = premiere.etat ? premiere.etat.libelle : null;
    }

    if (Array.isArray(j.documents)) {
      out.documents = j.documents.map(d => ({
        type: d.type || null,
        titre: d.titre || null,
        uuid: d.uuidDocument || null,
        url: d.uuidDocument
          ? `/api/v2/gaspar/${p.famille}/${p.id}/documents/${d.uuidDocument}`
          : null
      }));
      out.nombre_de_pieces = out.documents.length;
    } else {
      out.documents = [];
      out.remarque = "Le détail du plan ne comporte pas de tableau documents : la liste des pièces n'est peut-être accessible que par l'archive.";
    }
  } else {
    out.erreur = detail.extrait || null;
  }

  // --- Archive : on se contente d'en lire l'en-tete, sans la charger -----
  const urlZip = `${GEO}/api/v2/gaspar/${p.famille}/${p.id}/documents`;
  try {
    const r = await fetch(urlZip, {
      headers: { Authorization: `Bearer ${jeton}` },
      method: telecharger ? 'GET' : 'HEAD'
    });
    out.archive = {
      url: urlZip,
      methode: telecharger ? 'GET' : 'HEAD',
      code_http: r.status,
      type: r.headers.get('content-type'),
      taille_annoncee: r.headers.get('content-length')
    };
    if (telecharger && r.status === 200) {
      const buf = await r.arrayBuffer();
      out.archive.octets_recus = buf.byteLength;
      out.archive.signature = signature(new Uint8Array(buf));
      // Les noms de fichiers d'un zip sont lisibles en clair dans l'archive,
      // sans decompression : on les extrait pour connaitre le contenu.
      out.archive.fichiers = nomsDeZip(new Uint8Array(buf));
    }
  } catch (e) {
    out.archive = { url: urlZip, erreur: e.message };
  }

  return out;
}

async function appel(chemin, jeton) {
  try {
    const r = await fetch(`${GEO}${chemin}`, {
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' }
    });
    const txt = await r.text();
    if (r.status !== 200) return { ok: false, code: r.status, extrait: txt.slice(0, 200) };
    try { return { ok: true, code: 200, json: JSON.parse(txt) }; }
    catch { return { ok: false, code: 200, extrait: txt.slice(0, 200) }; }
  } catch (e) {
    return { ok: false, code: 0, extrait: e.message };
  }
}

// Identification sommaire du format par ses premiers octets.
function signature(o) {
  if (o.length < 4) return 'trop court';
  const q = [o[0], o[1], o[2], o[3]];
  if (q[0] === 0x50 && q[1] === 0x4B) return 'zip';
  if (q[0] === 0x25 && q[1] === 0x50 && q[2] === 0x44 && q[3] === 0x46) return 'pdf';
  return q.map(v => v.toString(16).padStart(2, '0')).join(' ');
}

// Les en-tetes locaux d'un zip contiennent les noms de fichiers en clair.
// Lecture sans decompression, suffisante pour inventorier l'archive.
function nomsDeZip(o) {
  const noms = [];
  const td = new TextDecoder('utf-8', { fatal: false });
  for (let i = 0; i + 30 < o.length && noms.length < 60; i++) {
    if (o[i] === 0x50 && o[i + 1] === 0x4B && o[i + 2] === 0x03 && o[i + 3] === 0x04) {
      const longueur = o[i + 26] | (o[i + 27] << 8);
      if (longueur > 0 && longueur < 300 && i + 30 + longueur <= o.length) {
        noms.push(td.decode(o.subarray(i + 30, i + 30 + longueur)));
      }
    }
  }
  return noms;
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
