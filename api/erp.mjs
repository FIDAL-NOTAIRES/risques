// RISQUES — /api/erp.mjs
//
// Generation de l'etat des risques en PDF, cote serveur.
//
// STRUCTURE, tiree de la grille de conformite etablie sur un ERRIAL reel
//   1. page de garde : intitule, date, fondement, parcelle, carte de situation
//   2. corps : uniquement les rubriques relevant de l'obligation (R.125-23),
//      chacune avec sa qualification, son fondement et sa carte
//   3. informations a preciser par le vendeur : trois champs declaratifs
//      et bloc signatures
//   4. annexe 1 : risques existants hors obligation IAL
//   5. annexe 2 : arretes de catastrophe naturelle, groupes par alea
//   6. annexe 3 : pollution des sols, CASIAS et ICPE
//   Pied de page sur chaque page : reference de la parcelle et pagination.
//
// CE QUE CE DOCUMENT N'EST PAS
// Il ne pretend pas etre l'ERRIAL. Aucun modele n'etant plus impose depuis
// l'arrete du 30 avril 2024, la conformite s'apprecie au contenu de R.125-23
// a R.125-25, non a la forme. Le document porte donc sa propre methode en
// clair, ce que l'ERRIAL ne fait pas.
//
// POLICES
// Georgia et Segoe UI sont proprietaires : Gelasio et Open Sans leur sont
// substituees (voir /lib/polices.mjs). L'ecart a la charte est assume et
// documente.
//
// Usage :
//   /api/erp?parcelle=62160-000-XM-0307
//   /api/erp?parcelle=...&dossier=0042
//   /api/erp?parcelle=...&cartes=0        sans cartographie, plus rapide
//   /api/erp?parcelle=...&debug=1         restitue les donnees, pas le PDF

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { police } from '../lib/polices.mjs';

const GEO = 'https://www.georisques.gouv.fr';
const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const WMS_IGN = 'https://data.geopf.fr/wms-r';
const WMS_RISQUES = 'https://mapsref.brgm.fr/wxs/georisques/risques';

// Charte FIDAL v2.2
const NUIT   = rgb(0.059, 0.133, 0.220);   // #0F2238
const CANARD = rgb(0.200, 0.514, 0.545);   // #33838B
const GRIS   = rgb(0.396, 0.490, 0.588);   // #657D96
const CARMIN = rgb(0.627, 0.063, 0.251);   // #A01040
const JAUNE  = rgb(1.000, 0.906, 0.392);   // #FFE764
const BLANC  = rgb(1, 1, 1);

// A4 en points typographiques
const PAGE = { l: 595.28, h: 841.89 };
const MARGE = { g: 56, d: 56, haut: 56, bas: 64 };
const UTILE = PAGE.l - MARGE.g - MARGE.d;

// Couches cartographiques par item de R.125-23, etablies par GetCapabilities
// et verifiees par sondage.
const CARTES_IAL = {
  pprn: 'PPRN_ZONE_INOND',
  pprt: 'PPRT_ZONE_RISQIND',
  pprm: 'PPRM_ZONE_MINIER',
  old:  'DEBROUSSAILLEMENT'
};

export default async function handler(req, res) {
  const t0 = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;
  const ref = req.query.parcelle ? req.query.parcelle.toString() : null;
  const dossier = req.query.dossier ? req.query.dossier.toString() : null;
  const avecCartes = req.query.cartes !== '0';

  if (!jeton) {
    return res.status(500).json({ resultat: 'ECHEC', cause: 'GEORISQUES_TOKEN absente.' });
  }
  if (!ref) {
    return res.status(400).json({
      resultat: 'ECHEC',
      cause: 'Parametre parcelle obligatoire.',
      exemple: '/api/erp?parcelle=62160-000-XM-0307&dossier=0042'
    });
  }

  try {
    const bien = await geometrieParcelle(ref);
    if (!bien.obtenu) {
      return res.status(200).json({ resultat: 'ECHEC', cause: bien.cause });
    }

    const donnees = await collecter(bien, jeton);
    const qualif = qualifier(donnees);

    if (req.query.debug === '1') {
      return res.status(200).json({
        horodatage: new Date().toISOString(),
        bien: { reference: ref, contenance: bien.contenance, centre: bien.centre },
        qualification: qualif,
        donnees,
        duree_ms: Date.now() - t0
      });
    }

    const pdf = await composer({ ref, dossier, bien, donnees, qualif, avecCartes });
    const nom = dossier ? `${dossier} ERP ${ref}.pdf` : `ERP ${ref}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nom}"`);
    return res.status(200).send(Buffer.from(pdf));

  } catch (e) {
    return res.status(500).json({
      resultat: 'ECHEC', cause: e.message,
      pile: (e.stack || '').split('\n').slice(0, 6),
      duree_ms: Date.now() - t0
    });
  }
}

// ===========================================================================
// COLLECTE
// ===========================================================================
async function collecter(bien, jeton) {
  const p = bien.reference;
  const insee = p.split('-')[0];
  const d = {};

  // Rubriques du corps, interrogees PAR PARCELLE : zoneRegExists depend de la
  // geometrie interrogee, une interrogation par commune produirait un faux
  // positif de masse.
  d.sismique = await v2('/api/v2/zonage_sismique', { codesParcelle: p }, jeton);
  d.radon    = await v2('/api/v2/radon',           { codesParcelle: p }, jeton);
  d.old      = await v2('/api/v2/old',             { codesParcelle: p }, jeton);
  d.pprn     = await v2('/api/v2/gaspar/pprn',     { codesParcelle: p }, jeton);
  d.pprt     = await v2('/api/v2/gaspar/pprt',     { codesParcelle: p }, jeton);
  d.pprm     = await v2('/api/v2/gaspar/pprm',     { codesParcelle: p }, jeton);

  // Annexes
  d.rga    = await v2('/api/v2/rga',        { codesParcelle: p }, jeton);
  d.casias = await v2('/api/v2/ssp/casias', { codesParcelle: p, rayon: '500' }, jeton);
  d.icpe   = await v2('/api/v2/installations_classees', { codesParcelle: p, rayon: '500' }, jeton);

  // CatNat : absent de la v2, exige par R.125-24 5°. Architecture hybride.
  d.catnat = await v1('/api/v1/gaspar/catnat', { code_insee: insee });

  // Geoportail de l'urbanisme
  d.commune = await gpu('municipality', bien.geometrie);
  d.docurba = await gpu('document', bien.geometrie);
  d.zonage  = await gpu('zone-urba', bien.geometrie);

  return d;
}

async function v2(chemin, criteres, jeton) {
  const q = new URLSearchParams(criteres);
  q.set('pageNumber', '0'); q.set('pageSize', '1000');
  try {
    const r = await fetch(`${GEO}${chemin}?${q}`, {
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' }
    });
    if (r.status !== 200) return { ok: false, code: r.status, items: [] };
    const j = await r.json();
    return { ok: true, total: j.totalElements, items: j.content || [] };
  } catch (e) {
    return { ok: false, erreur: e.message, items: [] };
  }
}

async function v1(chemin, criteres) {
  const q = new URLSearchParams(criteres);
  q.set('page', '1'); q.set('page_size', '500');
  try {
    const r = await fetch(`${GEO}${chemin}?${q}`, { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return { ok: false, code: r.status, items: [] };
    const j = await r.json();
    return { ok: true, total: j.results, items: j.data || [] };
  } catch (e) {
    return { ok: false, erreur: e.message, items: [] };
  }
}

async function gpu(couche, geometrie) {
  const q = new URLSearchParams({ geom: JSON.stringify(geometrie), _limit: '200' });
  try {
    const r = await fetch(`https://apicarto.ign.fr/api/gpu/${couche}?${q}`,
                          { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return { ok: false, code: r.status, items: [] };
    const j = await r.json();
    return { ok: true, items: (j.features || []).map(f => f.properties || {}) };
  } catch (e) {
    return { ok: false, erreur: e.message, items: [] };
  }
}

// ===========================================================================
// QUALIFICATION — seuils de R.125-23
// ===========================================================================
function qualifier(d) {
  const corps = [], ecartes = [], alertes = [];

  // 5° sismicite : obligation des la zone 2
  const s = d.sismique.items[0];
  if (s) {
    const z = parseInt(s.typeZone, 10);
    if (z >= 2) corps.push({
      cle: 'sismique', article: '5°', intitule: 'Sismicité',
      valeur: s.zoneSismicite,
      precision: "Fiche d'information sur le risque sismique à joindre (R.125-24, 2°)."
    });
    else ecartes.push({ intitule: 'Sismicité', article: '5°',
      motif: `zone ${z} : l'obligation ne naît qu'à partir de la zone 2` });
  }

  // 6° radon : niveau 3 exclusivement
  const r = d.radon.items[0];
  if (r) {
    const c = parseInt(r.classePotentiel, 10);
    if (c === 3) corps.push({
      cle: 'radon', article: '6°', intitule: 'Potentiel radon',
      valeur: `niveau ${c} sur 3`
    });
    else ecartes.push({ intitule: 'Potentiel radon', article: '6°',
      motif: `classe ${c} : seul le niveau 3 relève de l'obligation` });
  }

  // 8° debroussaillement
  if (d.old.items.length) {
    const o = d.old.items[0];
    corps.push({
      cle: 'old', article: '8°', intitule: 'Obligations légales de débroussaillement',
      valeur: o.departement ? `département ${o.departement}` : 'zone assujettie',
      precision: o.url ? `Fiche d'information à joindre : ${o.url}` : null
    });
  } else {
    ecartes.push({ intitule: 'Obligations légales de débroussaillement',
      article: '8°', motif: 'aucune zone couvrant le bien' });
  }

  // 1° a 4° : plans de prevention. Le discriminant est zoneRegExists.
  for (const [cle, art, nom] of [
    ['pprt', '1° et 4°', 'Plan de prévention des risques technologiques'],
    ['pprn', '2° et 4°', 'Plan de prévention des risques naturels'],
    ['pprm', '3° et 4°', 'Plan de prévention des risques miniers']
  ]) {
    const items = d[cle].items;
    const enZone = items.filter(e => e.zonageReglementaire &&
                                     e.zonageReglementaire.zoneRegExists === true);
    if (enZone.length) {
      for (const e of enZone) {
        const zones = (e.zonageReglementaire.listTypeReg || []);
        corps.push({
          cle, article: art, intitule: nom,
          valeur: e.libPpr,
          zones: zones.map(z => ({ code: z.codeZone, regime: z.libelle, nom: z.nom })),
          modele: e.modeleProcedure,
          revision: e.etatRevision === true,
          idGaspar: e.idGaspar,
          precision: "R.125-24 exige l'extrait du document graphique, l'extrait du règlement concernant le bien, et l'indication des travaux prescrits et de leur réalisation."
        });
      }
    } else if (items.length) {
      ecartes.push({ intitule: nom, article: art,
        motif: `${items.length} procédure(s) sur la commune, mais aucune zone délimitée couvrant le bien` });
    }
  }

  // 7° trait de cote : hors Georisques
  const com = d.commune.items[0];
  ecartes.push({ intitule: 'Recul du trait de côte', article: '7°',
    motif: com && com.is_coastline
      ? "commune littorale, mais aucune zone délimitée au document d'urbanisme"
      : 'commune non littorale' });
  if (com && com.is_coastline) {
    alertes.push("Commune littorale sans zone de recul du trait de côte délimitée. L'inscription d'une commune au décret du 29 avril 2022 modifié ne vaut pas délimitation ; l'absence peut aussi traduire un document d'urbanisme non encore actualisé.");
  }
  if (com && com.is_rnu) {
    alertes.push("Commune au règlement national d'urbanisme : l'absence de document d'urbanisme local ne signifie pas absence de règle.");
  }
  if (!d.docurba.items.length) {
    alertes.push("Aucun document d'urbanisme publié sur le Géoportail pour cette parcelle. Une absence sur le Géoportail ne prouve pas l'absence de document opposable.");
  }

  return { corps, ecartes, alertes };
}

// ===========================================================================
// RENDU
// ===========================================================================
async function composer({ ref, dossier, bien, donnees, qualif, avecCartes }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const serif  = await doc.embedFont(police('GELASIO_REGULAR'));
  const serifG = await doc.embedFont(police('GELASIO_BOLD'));
  const sans   = await doc.embedFont(police('SANS_REGULAR'));
  const sansG  = await doc.embedFont(police('SANS_BOLD'));
  const F = { serif, serifG, sans, sansG };

  const etat = { doc, F, pages: [], page: null, y: 0, ref, dossier };
  nouvellePage(etat);

  // --- Page de garde ----------------------------------------------------
  titre(etat, "ÉTAT DES RISQUES", 20, serifG);
  titre(etat, "pour l'information des acquéreurs et des locataires", 12.5, serif, CANARD);
  etat.y -= 10;
  filet(etat);
  etat.y -= 16;

  const auj = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  paragraphe(etat, `Établi le ${auj}.`, 10, sansG);
  etat.y -= 6;
  paragraphe(etat, "L'obligation d'information des acquéreurs et locataires résulte de l'article L. 125-5 du code de l'environnement. Le contenu du présent état est déterminé par les articles R. 125-23 et R. 125-24 du même code. Aucun modèle n'est imposé depuis l'abrogation de l'arrêté du 13 octobre 2005 par l'arrêté du 30 avril 2024.", 9.5, sans, GRIS);
  etat.y -= 4;
  paragraphe(etat, "Il appartient au vendeur ou au bailleur de vérifier l'exactitude de ces informations et, le cas échéant, de les compléter. Le présent état est établi depuis moins de six mois à la date de sa remise ; il doit être actualisé si les informations qu'il contient ne sont plus exactes à la date de signature de l'acte (R. 125-25, II).", 9.5, sans, GRIS);

  etat.y -= 14;
  encadre(etat, [
    ['Parcelle', ref],
    ['Contenance cadastrale', `${bien.contenance} m²`],
    ['Commune', libelleCommune(donnees)],
    ['Dossier', dossier || '—']
  ]);

  if (avecCartes) {
    etat.y -= 14;
    await carte(etat, bien, null, 'Situation du bien');
  }

  // --- Corps ------------------------------------------------------------
  nouvellePage(etat);
  section(etat, "Risques faisant l'objet de l'obligation d'information");

  if (!qualif.corps.length) {
    paragraphe(etat, "Aucun des risques énumérés à l'article R. 125-23 du code de l'environnement n'affecte le bien à la date d'établissement du présent état.", 10.5, serif);
    etat.y -= 6;
    paragraphe(etat, "Cette mention n'est pas un silence : chacune des huit rubriques de l'article R. 125-23 a été interrogée. Le détail des vérifications figure ci-après.", 9.5, sans, GRIS);
  } else {
    for (const c of qualif.corps) {
      await rubrique(etat, c, bien, avecCartes);
    }
  }

  etat.y -= 12;
  sousSection(etat, "Rubriques vérifiées et non retenues");
  paragraphe(etat, "Mention portée pour attester que la vérification a été effectuée.", 9, sans, GRIS);
  etat.y -= 4;
  for (const e of qualif.ecartes) {
    ligneEcart(etat, e);
  }

  if (qualif.alertes.length) {
    etat.y -= 12;
    sousSection(etat, "Points appelant une vérification");
    for (const a of qualif.alertes) {
      puce(etat, a, CARMIN);
    }
  }

  // --- Declaratif et signatures -----------------------------------------
  nouvellePage(etat);
  section(etat, "Informations à préciser par le vendeur ou le bailleur");
  paragraphe(etat, "Les trois éléments suivants ne peuvent être renseignés que par le vendeur ou le bailleur. Ils ne proviennent d'aucune base publique.", 9.5, sans, GRIS);
  etat.y -= 10;

  champ(etat, "Le bien a-t-il fait l'objet d'une indemnisation par une assurance à la suite d'une catastrophe naturelle, minière ou technologique ?");
  champ(etat, "Liste des travaux permettant l'arrêt des désordres, non réalisés bien qu'indemnisés ou ouvrant droit à indemnisation, consécutifs aux mouvements de terrain différentiels liés à la sécheresse et à la réhydratation des sols, survenus pendant la période de propriété (R. 125-24).");
  champ(etat, "Les travaux prescrits par le règlement du plan de prévention des risques pour ce bien ont-ils été réalisés ?");

  etat.y -= 20;
  paragraphe(etat, "Les parties signataires certifient avoir pris connaissance des informations restituées dans le présent document, avoir été en mesure de les corriger et, le cas échéant, de les compléter.", 9.5, serif);
  etat.y -= 26;
  signatures(etat);

  // --- Annexe 1 ---------------------------------------------------------
  nouvellePage(etat);
  section(etat, "Annexe 1 — Risques existants hors obligation d'information");
  paragraphe(etat, "Les éléments ci-après ne relèvent pas de l'article R. 125-23. Ils sont portés à connaissance pour leur intérêt pratique.", 9.5, sans, GRIS);
  etat.y -= 10;
  annexeHorsIal(etat, donnees);

  // --- Annexe 2 : CatNat ------------------------------------------------
  nouvellePage(etat);
  section(etat, "Annexe 2 — Arrêtés de reconnaissance de l'état de catastrophe naturelle");
  paragraphe(etat, "Liste des arrêtés pris sur la commune (R. 125-24, 5°). Source : Caisse centrale de réassurance. Aucune limitation de profondeur n'est appliquée.", 9.5, sans, GRIS);
  etat.y -= 10;
  annexeCatnat(etat, donnees);

  // --- Annexe 3 : pollution des sols ------------------------------------
  nouvellePage(etat);
  section(etat, "Annexe 3 — Pollution des sols et installations classées");
  paragraphe(etat, "Rayon de 500 mètres mesuré depuis le centroïde de la parcelle. Aucun filtre implicite n'est appliqué : ni sur le statut, ni sur l'ancienneté. Les établissements de régime « Non ICPE » sont écartés, cette exclusion étant énoncée ici.", 9.5, sans, GRIS);
  etat.y -= 10;
  annexeSols(etat, donnees, bien);

  // --- Methode ----------------------------------------------------------
  etat.y -= 16;
  sousSection(etat, "Sources et méthode");
  for (const t of [
    "Géorisques, interfaces v2 et v1, interrogées par référence cadastrale.",
    "Géoportail de l'urbanisme, module GPU d'API Carto, interrogé par géométrie parcellaire.",
    "Géométrie de la parcelle : API Carto de l'IGN, module cadastre.",
    "La qualification applique les seuils de l'article R. 125-23 : sismicité à partir de la zone 2, radon au seul niveau 3, plans de prévention seulement si une zone délimitée couvre le bien.",
    "Composition : Gelasio et Open Sans, substituts libres de Georgia et Segoe UI, ces dernières étant sous licence propriétaire."
  ]) puce(etat, t, GRIS, 8.5);

  pieds(etat);
  return doc.save();
}

// ===========================================================================
// PRIMITIVES DE MISE EN PAGE
// ===========================================================================
function nouvellePage(e) {
  e.page = e.doc.addPage([PAGE.l, PAGE.h]);
  e.pages.push(e.page);
  e.y = PAGE.h - MARGE.haut;
}

function place(e, hauteur) {
  if (e.y - hauteur < MARGE.bas) nouvellePage(e);
}

function titre(e, texte, taille, fonte, couleur = NUIT) {
  place(e, taille + 10);
  e.page.drawText(texte, { x: MARGE.g, y: e.y - taille, size: taille, font: fonte, color: couleur });
  e.y -= taille + 8;
}

function section(e, texte) {
  place(e, 40);
  e.page.drawRectangle({ x: MARGE.g, y: e.y - 20, width: 3, height: 18, color: JAUNE });
  e.page.drawText(texte, { x: MARGE.g + 11, y: e.y - 16, size: 13, font: e.F.serifG, color: NUIT });
  e.y -= 32;
}

function sousSection(e, texte) {
  place(e, 26);
  e.page.drawText(texte, { x: MARGE.g, y: e.y - 12, size: 10.5, font: e.F.sansG, color: CANARD });
  e.y -= 22;
}

function filet(e) {
  place(e, 6);
  e.page.drawLine({
    start: { x: MARGE.g, y: e.y }, end: { x: PAGE.l - MARGE.d, y: e.y },
    thickness: 0.7, color: GRIS
  });
  e.y -= 4;
}

function decouper(texte, fonte, taille, largeur) {
  const mots = String(texte).replace(/\s+/g, ' ').trim().split(' ');
  const lignes = []; let courante = '';
  for (const m of mots) {
    const essai = courante ? `${courante} ${m}` : m;
    if (fonte.widthOfTextAtSize(essai, taille) > largeur && courante) {
      lignes.push(courante); courante = m;
    } else courante = essai;
  }
  if (courante) lignes.push(courante);
  return lignes;
}

function paragraphe(e, texte, taille, fonte, couleur = NUIT, indent = 0) {
  const largeur = UTILE - indent;
  const interligne = taille * 1.45;
  for (const l of decouper(texte, fonte, taille, largeur)) {
    place(e, interligne);
    e.page.drawText(l, { x: MARGE.g + indent, y: e.y - taille, size: taille, font: fonte, color: couleur });
    e.y -= interligne;
  }
}

function puce(e, texte, couleur = NUIT, taille = 9.5) {
  place(e, taille * 1.5);
  e.page.drawCircle({ x: MARGE.g + 3, y: e.y - taille * 0.55, size: 1.6, color: couleur });
  paragraphe(e, texte, taille, e.F.sans, couleur, 14);
  e.y -= 2;
}

function encadre(e, lignes) {
  const hauteur = lignes.length * 17 + 16;
  place(e, hauteur);
  e.page.drawRectangle({
    x: MARGE.g, y: e.y - hauteur, width: UTILE, height: hauteur,
    color: rgb(0.957, 0.965, 0.973), borderColor: GRIS, borderWidth: 0.6
  });
  let y = e.y - 20;
  for (const [k, v] of lignes) {
    e.page.drawText(k, { x: MARGE.g + 14, y, size: 9, font: e.F.sans, color: GRIS });
    e.page.drawText(String(v), { x: MARGE.g + 168, y, size: 9.5, font: e.F.sansG, color: NUIT });
    y -= 17;
  }
  e.y -= hauteur;
}

function ligneEcart(e, ec) {
  place(e, 26);
  const etiquette = `${ec.intitule} (R. 125-23, ${ec.article})`;
  e.page.drawText(etiquette, { x: MARGE.g, y: e.y - 9, size: 9, font: e.F.sansG, color: NUIT });
  e.y -= 13;
  paragraphe(e, ec.motif, 8.5, e.F.sans, GRIS, 10);
  e.y -= 3;
}

function champ(e, question) {
  place(e, 52);
  paragraphe(e, question, 9.5, e.F.sans, NUIT);
  e.y -= 4;
  e.page.drawRectangle({
    x: MARGE.g, y: e.y - 26, width: UTILE, height: 26,
    borderColor: GRIS, borderWidth: 0.6, color: BLANC
  });
  e.y -= 34;
}

function signatures(e) {
  place(e, 80);
  const col = (UTILE - 24) / 3;
  const noms = ['Vendeur ou bailleur', 'Date et lieu', 'Acquéreur ou locataire'];
  noms.forEach((n, i) => {
    const x = MARGE.g + i * (col + 12);
    e.page.drawText(n, { x, y: e.y - 9, size: 8.5, font: e.F.sans, color: GRIS });
    e.page.drawRectangle({ x, y: e.y - 66, width: col, height: 50,
      borderColor: GRIS, borderWidth: 0.6, color: BLANC });
  });
  e.y -= 74;
}

function pieds(e) {
  const total = e.pages.length;
  e.pages.forEach((p, i) => {
    const gauche = e.dossier ? `${e.dossier} — ${e.ref}` : e.ref;
    p.drawLine({ start: { x: MARGE.g, y: MARGE.bas - 18 }, end: { x: PAGE.l - MARGE.d, y: MARGE.bas - 18 },
                 thickness: 0.5, color: GRIS });
    p.drawText(gauche, { x: MARGE.g, y: MARGE.bas - 32, size: 7.5, font: e.F.sans, color: GRIS });
    const pag = `${i + 1} / ${total}`;
    const w = e.F.sans.widthOfTextAtSize(pag, 7.5);
    p.drawText(pag, { x: PAGE.l - MARGE.d - w, y: MARGE.bas - 32, size: 7.5, font: e.F.sans, color: GRIS });
  });
}

// ===========================================================================
// RUBRIQUES ET CARTES
// ===========================================================================
async function rubrique(e, c, bien, avecCartes) {
  place(e, 60);
  e.page.drawRectangle({ x: MARGE.g, y: e.y - 22, width: UTILE, height: 22, color: NUIT });
  e.page.drawText(c.intitule, { x: MARGE.g + 10, y: e.y - 15, size: 10.5, font: e.F.sansG, color: BLANC });
  const art = `R. 125-23, ${c.article}`;
  const w = e.F.sans.widthOfTextAtSize(art, 8);
  e.page.drawText(art, { x: PAGE.l - MARGE.d - w - 10, y: e.y - 15, size: 8, font: e.F.sans, color: JAUNE });
  e.y -= 32;

  paragraphe(e, c.valeur, 11, e.F.serifG, CARMIN);
  e.y -= 2;

  if (c.zones && c.zones.length) {
    for (const z of c.zones) {
      puce(e, `Zone ${z.code} — ${z.regime}${z.nom ? ` : ${z.nom}` : ''}`, NUIT, 9);
    }
  }
  if (c.revision) {
    puce(e, "Ce plan est en cours de révision à la date d'établissement du présent état.", CARMIN, 9);
  }
  if (c.precision) {
    paragraphe(e, c.precision, 8.5, e.F.sans, GRIS);
  }

  if (avecCartes && CARTES_IAL[c.cle]) {
    e.y -= 8;
    await carte(e, bien, CARTES_IAL[c.cle], c.intitule);
  }
  e.y -= 14;
}

async function carte(e, bien, couche, legende) {
  const largeur = UTILE;
  const hauteur = Math.round(largeur * 0.62);
  const px = { l: 900, h: Math.round(900 * 0.62) };
  const marge = margeAdaptee(bien.contenance);
  const bbox = emprise(bien.centre, marge, px);

  place(e, hauteur + 26);

  try {
    const fond = await image(getMap(WMS_IGN, 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', bbox, px, false));
    if (fond) {
      const img = await e.doc.embedJpg(fond);
      e.page.drawImage(img, { x: MARGE.g, y: e.y - hauteur, width: largeur, height: hauteur });
    }
    if (couche) {
      const sur = await image(getMap(WMS_RISQUES, couche, bbox, px, true));
      if (sur) {
        const img = await e.doc.embedPng(sur);
        e.page.drawImage(img, { x: MARGE.g, y: e.y - hauteur, width: largeur, height: hauteur, opacity: 0.6 });
      }
    }
  } catch (err) {
    e.page.drawText(`Cartographie indisponible : ${err.message}`, {
      x: MARGE.g + 6, y: e.y - 16, size: 8, font: e.F.sans, color: CARMIN });
  }

  // Contour parcellaire, en vecteur
  for (const anneau of (bien.anneaux || [])) {
    for (let i = 0; i < anneau.length - 1; i++) {
      const a = projeter(anneau[i], bbox, largeur, hauteur);
      const b = projeter(anneau[i + 1], bbox, largeur, hauteur);
      e.page.drawLine({
        start: { x: MARGE.g + a.x, y: e.y - hauteur + a.y },
        end:   { x: MARGE.g + b.x, y: e.y - hauteur + b.y },
        thickness: 1.4, color: CARMIN
      });
    }
  }

  e.page.drawRectangle({ x: MARGE.g, y: e.y - hauteur, width: largeur, height: hauteur,
    borderColor: GRIS, borderWidth: 0.6 });
  e.y -= hauteur + 4;
  e.page.drawText(`${legende} — emprise ${marge * 2} m — contour cadastral en carmin`, {
    x: MARGE.g, y: e.y - 9, size: 7.5, font: e.F.sans, color: GRIS });
  e.y -= 16;
}

async function image(url) {
  const r = await fetch(url);
  const type = r.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 200) return null;   // PNG transparent vide
  return new Uint8Array(buf);
}

function projeter([lon, lat], bbox, largeur, hauteur) {
  return {
    x: (lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin) * largeur,
    y: (lat - bbox.latMin) / (bbox.latMax - bbox.latMin) * hauteur
  };
}

// ===========================================================================
// ANNEXES
// ===========================================================================
function annexeHorsIal(e, d) {
  const rga = d.rga.items[0];
  if (rga) {
    sousSection(e, "Retrait-gonflement des sols argileux");
    paragraphe(e, `Exposition : ${rga.exposition} (niveau ${rga.codeExposition} sur 3).`, 10, e.F.serif);
    if (parseInt(rga.codeExposition, 10) >= 2) {
      paragraphe(e, "En zone d'exposition moyenne ou forte, une étude géotechnique préalable est obligatoire avant construction.", 9, e.F.sans, CARMIN);
    }
    e.y -= 8;
  }

  const z = d.zonage.items[0];
  if (z) {
    sousSection(e, "Document d'urbanisme applicable");
    const doc = d.docurba.items[0] || {};
    paragraphe(e, `${doc.grid_title || 'document'} — zone ${z.libelle || '—'}${z.typezone ? ` (type ${z.typezone})` : ''}.`, 10, e.F.serif);
    if (z.nomfic) paragraphe(e, `Règlement : ${z.nomfic}`, 8.5, e.F.sans, GRIS);
    e.y -= 8;
  }

  if (!d.rga.items.length && !d.zonage.items.length) {
    paragraphe(e, "Aucun élément à porter en annexe 1.", 10, e.F.serif, GRIS);
  }
}

function annexeCatnat(e, d) {
  const items = d.catnat.items;
  if (!items.length) {
    paragraphe(e, "Aucun arrêté de reconnaissance de l'état de catastrophe naturelle n'a été pris sur la commune.", 10, e.F.serif);
    return;
  }
  const groupes = {};
  for (const a of items) {
    const k = a.libelle_risque_jo || 'Non précisé';
    (groupes[k] = groupes[k] || []).push(a);
  }
  paragraphe(e, `${items.length} arrêté(s), répartis en ${Object.keys(groupes).length} catégorie(s) d'aléa.`, 9.5, e.F.sansG);
  e.y -= 8;

  for (const [alea, liste] of Object.entries(groupes)) {
    place(e, 40);
    e.page.drawText(`${alea} — ${liste.length}`, { x: MARGE.g, y: e.y - 10, size: 9.5, font: e.F.sansG, color: CANARD });
    e.y -= 18;
    entete(e, ['Code national', 'Début', 'Fin', 'Arrêté du', 'Journal officiel'], [130, 80, 80, 85, 90]);
    for (const a of liste.sort((x, y) => (y.date_debut_evt || '').localeCompare(x.date_debut_evt || ''))) {
      rangee(e, [a.code_national_catnat, a.date_debut_evt, a.date_fin_evt,
                 a.date_publication_arrete, a.date_publication_jo], [130, 80, 80, 85, 90]);
    }
    e.y -= 10;
  }
}

function annexeSols(e, d, bien) {
  // ICPE : les etablissements de regime "Non ICPE" sont ecartes.
  const icpe = d.icpe.items.filter(x => {
    const r = (x.regime || '').toLowerCase();
    return r && !r.includes('non icpe');
  });

  sousSection(e, `Installations classées — ${icpe.length} retenue(s) sur ${d.icpe.items.length} établissement(s) recensés`);
  if (icpe.length) {
    entete(e, ['Raison sociale', 'Régime', 'État'], [250, 110, 120]);
    for (const x of icpe.slice(0, 40)) {
      rangee(e, [x.raisonSociale || '—', x.regime || '—', x.etatActivite || 'non précisé'], [250, 110, 120]);
    }
    e.y -= 6;
    paragraphe(e, "La majorité des établissements de cette base ne porte pas de coordonnées individuelles mais celles du centre de la commune : aucune distance au bien n'est donc indiquée, plutôt qu'une distance fausse.", 8, e.F.sans, GRIS);
  } else {
    paragraphe(e, "Aucune installation soumise à autorisation ou à enregistrement dans le rayon retenu.", 10, e.F.serif);
  }

  e.y -= 12;
  const cas = d.casias.items;
  sousSection(e, `Anciens sites industriels et activités de services — ${cas.length} site(s)`);
  if (cas.length) {
    entete(e, ['Site', 'Statut', 'Distance'], [270, 100, 80]);
    const avec = cas.map(x => ({ x, m: distance(bien.centre, x.geom) }))
                    .sort((a, b) => (a.m ?? 1e9) - (b.m ?? 1e9));
    for (const { x, m } of avec.slice(0, 45)) {
      rangee(e, [x.nom || x.activitePrincipale || '—', x.statut || '—',
                 m === null ? 'non localisé' : `${m} m`], [270, 100, 80]);
    }
  } else {
    paragraphe(e, "Aucun site recensé dans le rayon retenu.", 10, e.F.serif);
  }
}

function entete(e, cols, largeurs) {
  place(e, 20);
  e.page.drawRectangle({ x: MARGE.g, y: e.y - 14, width: UTILE, height: 14, color: rgb(0.91, 0.93, 0.95) });
  let x = MARGE.g + 5;
  cols.forEach((c, i) => {
    e.page.drawText(c, { x, y: e.y - 10.5, size: 7.5, font: e.F.sansG, color: NUIT });
    x += largeurs[i];
  });
  e.y -= 17;
}

function rangee(e, valeurs, largeurs) {
  place(e, 13);
  let x = MARGE.g + 5;
  valeurs.forEach((v, i) => {
    let t = String(v ?? '—');
    while (e.F.sans.widthOfTextAtSize(t, 7.5) > largeurs[i] - 8 && t.length > 4) {
      t = t.slice(0, -2);
    }
    if (t !== String(v ?? '—')) t += '…';
    e.page.drawText(t, { x, y: e.y - 8, size: 7.5, font: e.F.sans, color: NUIT });
    x += largeurs[i];
  });
  e.y -= 12;
}

// ===========================================================================
// OUTILS
// ===========================================================================
async function geometrieParcelle(reference) {
  const m = reference.split('-');
  if (m.length !== 4) return { obtenu: false, cause: `Référence non décomposable : ${reference}` };
  const [insee, comAbs, section2, numero] = m;
  const url = `${IGN_CADASTRE}?code_insee=${insee}&section=${section2}&numero=${numero}&com_abs=${comAbs}&_limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = await r.json();
    const t = j.features || [];
    if (!t.length) return { obtenu: false, cause: 'Parcelle introuvable au cadastre IGN.' };
    const anneaux = extraireAnneaux(t[0].geometry);
    const pts = anneaux.flat();
    return {
      obtenu: true, reference, geometrie: t[0].geometry, anneaux,
      contenance: (t[0].properties || {}).contenance,
      centre: {
        lon: pts.reduce((a, p) => a + p[0], 0) / pts.length,
        lat: pts.reduce((a, p) => a + p[1], 0) / pts.length
      }
    };
  } catch (err) {
    return { obtenu: false, cause: err.message };
  }
}

function extraireAnneaux(geom) {
  const out = [];
  const parcourir = (x) => {
    if (!Array.isArray(x) || typeof x[0] === 'number') return;
    if (Array.isArray(x[0]) && typeof x[0][0] === 'number') { out.push(x); return; }
    x.forEach(parcourir);
  };
  if (geom) parcourir(geom.coordinates);
  return out;
}

function margeAdaptee(contenance) {
  if (!contenance) return 250;
  return Math.max(60, Math.min(1200, Math.round(Math.sqrt(contenance) * 2.5)));
}

function emprise(centre, marge, px) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(centre.lat * Math.PI / 180);
  const rapport = px.l / px.h;
  const demiL = rapport >= 1 ? marge * rapport : marge;
  const demiH = rapport >= 1 ? marge : marge / rapport;
  return {
    lonMin: centre.lon - demiL / mLon, latMin: centre.lat - demiH / mLat,
    lonMax: centre.lon + demiL / mLon, latMax: centre.lat + demiH / mLat
  };
}

function getMap(service, couche, bbox, px, transparent) {
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
    LAYERS: couche, STYLES: '', CRS: 'EPSG:4326',
    BBOX: `${bbox.latMin},${bbox.lonMin},${bbox.latMax},${bbox.lonMax}`,
    WIDTH: String(px.l), HEIGHT: String(px.h),
    FORMAT: transparent ? 'image/png' : 'image/jpeg',
    TRANSPARENT: transparent ? 'TRUE' : 'FALSE'
  });
  return `${service}?${p}`;
}

function distance(centre, geom) {
  if (!geom) return null;
  let pt = null;
  if (geom.type === 'Point' && Array.isArray(geom.coordinates)) pt = geom.coordinates;
  else if (geom.coordinates && typeof geom.coordinates.longitude === 'number') {
    pt = [geom.coordinates.longitude, geom.coordinates.latitude];
  }
  if (!pt) return null;
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(pt[1] - centre.lat), dLon = rad(pt[0] - centre.lon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(centre.lat)) * Math.cos(rad(pt[1])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function libelleCommune(d) {
  const c = d.commune.items[0];
  if (!c) return '—';
  return `${c.name || '—'} (${c.insee || '—'})`;
}
