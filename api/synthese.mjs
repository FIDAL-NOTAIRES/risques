// RISQUES — /api/synthese.mjs
//
// RAPPORT DE SYNTHESE EXHAUSTIF — document de CONSEIL, distinct de l'etat
// des risques, qui reste ferme. La ou l'ERP ne restitue que les rubriques
// relevant de l'obligation, la synthese affiche les SEIZE rubriques, y
// compris celles ou le bien n'est pas concerne, pour tracer la diligence.
//
// LES SEIZE RUBRIQUES, DANS L'ORDRE REGLEMENTAIRE (tranche le 16/09/2026)
//   Regime IAL (L.125-5, R.125-23)
//     1  PPRT approuve                         5  Sismicite
//     2  PPRN approuve                         6  Radon
//     3  PPRM approuve                         7  Recul du trait de cote
//     4  Perimetre mis a l'etude (prescrit)    8  Debroussaillement (OLD)
//   Pollution des sols (L.125-6, L.125-7)
//     9  SIS          10  ICPE          11  CASIAS
//   Nuisances sonores aeriennes
//    12  Plan d'exposition au bruit
//   Information complementaire hors IAL
//    13  Retrait-gonflement des argiles     14  Remontee de nappe
//    15  Canalisations de matieres dangereuses
//   Sinistralite
//    16  Arretes de catastrophe naturelle (carte COMMUNALE)
//
// STRUCTURE (tranchee les 15 et 16/09/2026)
//   - page de garde : plan cadastral avec la parcelle colorisee en carmin,
//     puis vue aerienne et situation communale ; adresse et reference
//     cadastrale seulement, pas de nom de proprietaire ;
//   - encadre de tete : UNIQUEMENT si un risque atteint le niveau maximal
//     de sa propre echelle ; sinon aucun encadre, on reste muet ;
//   - corps : un triptyque par rubrique — phrase de synthese, donnees,
//     carte — QUATRE CARTES PAR PAGE, echelle uniforme, repere en croix ;
//     les rubriques non concernees restent A LEUR PLACE avec la mention ;
//   - annexe de detail, meme ordre, portant les references juridiques ;
//     le corps renvoie a l'annexe par un lien cliquable ;
//   - sources interrogees en fin de rapport ;
//   - pied de page : adresse, date d'etablissement, pagination.
//
// BASE NON REPONDANTE : la generation n'est jamais bloquee ; la rubrique
// porte « donnee non obtenue » en JAUNE (convention de la suite).
//
// Usage :
//   /api/synthese?parcelle=62160-000-XM-0307
//   /api/synthese?parcelle=...&dossier=0042
//   /api/synthese?parcelle=...&cartes=0        sans cartographie, plus rapide
//   /api/synthese?parcelle=...&debug=1         restitue les rubriques, pas le PDF

import { PDFDocument, PDFName, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { police } from '../lib/polices.mjs';
import {
  WMS_IGN, WMS_RISQUES, COUCHES_SYNTHESE,
  geometrieParcelle, collecterSynthese, qualifier, adressePostale,
  image, projeter, margeAdaptee, emprise, getMap, distance, libelleCommune,
  etatPlan, cleDate, icpeRetenues
} from '../lib/moisson.mjs';

// Charte FIDAL v2.2
const NUIT   = rgb(0.059, 0.133, 0.220);   // #0F2238
const CANARD = rgb(0.200, 0.514, 0.545);   // #33838B
const GRIS   = rgb(0.396, 0.490, 0.588);   // #657D96
const CARMIN = rgb(0.627, 0.063, 0.251);   // #A01040
const JAUNE  = rgb(1.000, 0.906, 0.392);   // #FFE764
const JAUNE_PALE = rgb(1.000, 0.973, 0.820);
const BLANC  = rgb(1, 1, 1);
const FOND   = rgb(0.957, 0.965, 0.973);

// A4 en points typographiques
const PAGE = { l: 595.28, h: 841.89 };
const MARGE = { g: 56, d: 56, haut: 56, bas: 64 };
const UTILE = PAGE.l - MARGE.g - MARGE.d;

// Grille du corps : deux colonnes, deux rangees, soit quatre cartes par page
const GOUTTIERE = 14;
const CELL_L = (UTILE - GOUTTIERE) / 2;
const CARTE_H = Math.round(CELL_L * 0.86);
const PX = { l: 640, h: Math.round(640 * 0.86) };
const MARGE_COMMUNALE = 2500;   // rubrique CatNat : carte a l'echelle de la commune

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
      exemple: '/api/synthese?parcelle=62160-000-XM-0307&dossier=0042'
    });
  }

  try {
    const bien = await geometrieParcelle(ref);
    if (!bien.obtenu) {
      return res.status(200).json({ resultat: 'ECHEC', cause: bien.cause });
    }

    const [donnees, adresse] = await Promise.all([
      collecterSynthese(bien, jeton),
      adressePostale(bien.centre)
    ]);
    const qualif = qualifier(donnees);
    const rubriques = construireRubriques(donnees, qualif, bien);
    const horodatage = new Date();

    if (req.query.debug === '1') {
      return res.status(200).json({
        horodatage: horodatage.toISOString(),
        bien: { reference: ref, contenance: bien.contenance, centre: bien.centre, adresse },
        encadre: rubriques.filter(r => r.maximal).map(r => ({ numero: r.numero, intitule: r.intitule, maximal: r.maximal })),
        rubriques: rubriques.map(r => ({ ...r, carte: r.carte ? { couche: r.carte.couche, echelle: r.carte.echelle } : null })),
        sources: sources(donnees, horodatage),
        duree_ms: Date.now() - t0
      });
    }

    const pdf = await composer({ ref, dossier, bien, adresse, donnees, rubriques, horodatage, avecCartes });
    const nom = dossier ? `${dossier} SYNTHESE ${ref}.pdf` : `SYNTHESE ${ref}.pdf`;

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
// CONSTRUCTION DES SEIZE RUBRIQUES
// ===========================================================================
// Chaque rubrique : { numero, cle, intitule, regime, fondement, statut,
//   phrase, donnees: [[etiquette, valeur]], detail: [paragraphes],
//   carte: { service, couche, echelle }, maximal: null | texte }
// statut : 'concerne' | 'non_concerne' | 'non_obtenu'
function construireRubriques(d, qualif, bien) {
  const R = [];
  const com = d.commune.items[0] || {};

  // -- Plans de prevention approuves (1°, 2°, 3°) ---------------------------
  for (const [numero, cle, article, intitule, motCle] of [
    [1, 'pprt', '1°', 'Plan de prévention des risques technologiques approuvé', 'PPRT'],
    [2, 'pprn', '2°', 'Plan de prévention des risques naturels approuvé', 'PPRN'],
    [3, 'pprm', '3°', 'Plan de prévention des risques miniers approuvé', 'PPRM']
  ]) {
    const src = d[cle];
    const approuves = src.items.filter(e => etatPlan(e) !== 'prescrit');
    const enZone = approuves.filter(e => e.zonageReglementaire && e.zonageReglementaire.zoneRegExists === true);
    const r = base(numero, cle, intitule, 'IAL', `L. 125-5 ; R. 125-23, ${article}`);
    r.carte = coucheDuPlan(cle, enZone[0] || approuves[0]);

    if (!src.ok) { R.push(nonObtenu(r, 'Géorisques (GASPAR)')); continue; }
    if (enZone.length) {
      const e = enZone[0];
      const zones = (e.zonageReglementaire.listTypeReg || []).map(z => `${z.codeZone} — ${z.libelle}${z.nom ? ` (${z.nom})` : ''}`);
      r.statut = 'concerne';
      r.phrase = `Le bien est situé dans une zone délimitée par le plan « ${e.libPpr} »${zones.length ? `, en zone ${zones[0].split(' — ')[0]}` : ''}.`;
      r.donnees = [['Plan', e.libPpr], ['Zone(s)', zones.join(' ; ') || '—'],
                   ['Procédure', e.modeleProcedure || '—'], ['Révision en cours', e.etatRevision === true ? 'oui' : 'non']];
      r.detail = [
        `Plan ${motCle} « ${e.libPpr} », identifiant GASPAR ${e.idGaspar || '—'}. Zonage réglementaire couvrant le bien : ${zones.join(' ; ') || 'non détaillé par la source'}.`,
        "L'article R. 125-24 impose d'annexer à l'état des risques l'extrait du document graphique situant le bien, l'extrait du règlement le concernant et l'indication des travaux prescrits et de leur réalisation. Ces pièces sont traitées dans l'état des risques, non dans le présent rapport.",
        ...(e.etatRevision === true ? ["Le plan est en cours de révision : le zonage et le règlement peuvent évoluer avant la signature de l'acte."] : [])
      ];
      r.maximal = zoneMaximale(zones, motCle);
      if (numero === 2 && d.tri && d.tri.obtenu && d.tri.items.length) {
        r.donnees.push(['Directive inondation', `commune couverte par un TRI ; l'aléa de référence retenu est le scénario moyen (crue centennale)`]);
      }
    } else if (approuves.length) {
      r.statut = 'non_concerne';
      r.phrase = `${approuves.length} plan(s) ${motCle} sur la commune, mais aucune zone délimitée ne couvre le bien.`;
      r.donnees = [['Plans sur la commune', approuves.map(e => e.libPpr).join(' ; ')]];
      r.detail = [`Procédure(s) recensée(s) sur la commune : ${approuves.map(e => `« ${e.libPpr} »`).join(', ')}. Le discriminant retenu est la géométrie parcellaire (zoneRegExists), non le code INSEE : une interrogation à la commune produirait un faux positif.`];
    } else {
      r.statut = 'non_concerne';
      r.phrase = `Aucun plan ${motCle} approuvé ne concerne la commune.`;
      r.detail = [`Aucune procédure ${motCle} approuvée ou rendue immédiatement opposable n'est recensée dans la base GASPAR pour cette commune.`];
    }
    R.push(r);
  }

  // -- 4° Perimetre mis a l'etude --------------------------------------------
  {
    const r = base(4, 'prescrits', "Périmètre mis à l'étude (plan seulement prescrit)", 'IAL', 'L. 125-5 ; R. 125-23, 4°');
    r.carte = COUCHES_SYNTHESE.prescrits;
    const familles = ['pprt', 'pprn', 'pprm'];
    const muettes = familles.filter(k => !d[k].ok);
    const toutes = familles.filter(k => d[k].ok).flatMap(k => d[k].items.map(e => ({ ...e, famille: k.toUpperCase() })));
    const prescrits = toutes.filter(e => etatPlan(e) === 'prescrit');
    // Une famille muette sur trois ne fait pas taire la rubrique : on
    // restitue ce qui a repondu et on dit ce qui manque.
    const lacune = muettes.length ? ` Famille(s) non obtenue(s) : ${muettes.map(k => k.toUpperCase()).join(', ')} — à compléter.` : '';
    if (muettes.length === familles.length) R.push(nonObtenu(r, 'Géorisques (GASPAR)'));
    else if (prescrits.length) {
      r.statut = 'concerne';
      r.phrase = `${prescrits.length} plan(s) prescrit(s) et non encore approuvé(s) : ${prescrits.map(e => e.libPpr).slice(0, 2).join(' ; ')}${prescrits.length > 2 ? '…' : ''}.${lacune}`;
      r.donnees = prescrits.slice(0, 4).map(e => [e.famille, `${e.libPpr} — ${e.libelleEtatProcedure || e.etatProcedure || 'prescrit'}`]);
      r.detail = [
        "Le 4° de l'article R. 125-23 vise les périmètres mis à l'étude dans le cadre d'un plan seulement prescrit. L'obligation d'information naît donc avant l'approbation : on ne filtre pas sur le statut « approuvé »." + lacune,
        ...prescrits.map(e => `${e.famille} « ${e.libPpr} » — état : ${e.libelleEtatProcedure || e.etatProcedure || 'prescrit'} — identifiant GASPAR ${e.idGaspar || '—'}.`)
      ];
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = "Aucun plan de prévention prescrit et non approuvé sur la commune." + lacune;
      r.detail = ["Aucune procédure à l'état prescrit n'est recensée dans GASPAR pour la commune." + lacune];
      R.push(r);
    }
  }

  // -- 5° Sismicite ------------------------------------------------------------
  {
    const r = base(5, 'sismique', 'Sismicité', 'IAL', 'L. 125-5 ; R. 125-23, 5° ; D. 563-8-1 code de l\'environnement');
    r.carte = COUCHES_SYNTHESE.sismique;
    const s = d.sismique.items[0];
    if (!d.sismique.ok) R.push(nonObtenu(r, 'Géorisques (zonage sismique)'));
    else if (!s) { r.statut = 'non_concerne'; r.phrase = 'Zonage sismique non renseigné pour la parcelle.'; R.push(r); }
    else {
      const z = parseInt(s.typeZone, 10);
      r.statut = z >= 2 ? 'concerne' : 'non_concerne';
      r.phrase = z >= 2
        ? `Zone de sismicité ${z} (${s.zoneSismicite}) : l'information est due et la fiche sismique doit être annexée à l'état des risques.`
        : `Zone de sismicité ${z} (${s.zoneSismicite}) : l'obligation ne naît qu'à partir de la zone 2.`;
      r.donnees = [['Zone', `${z} sur 5`], ['Libellé', s.zoneSismicite || '—']];
      r.detail = ["Échelle de 1 (très faible) à 5 (forte). L'obligation d'information s'applique dès la zone 2 ; en zone 2 et au-delà, les règles de construction parasismique (arrêté du 22 octobre 2010 modifié) peuvent s'appliquer selon la catégorie du bâtiment."];
      if (z === 5) r.maximal = 'Zone de sismicité 5, niveau le plus élevé de l\'échelle nationale : règles parasismiques renforcées pour toute construction.';
      R.push(r);
    }
  }

  // -- 6° Radon -----------------------------------------------------------------
  {
    const r = base(6, 'radon', 'Potentiel radon', 'IAL', 'L. 125-5 ; R. 125-23, 6° ; arrêté du 27 juin 2018');
    r.carte = COUCHES_SYNTHESE.radon;
    const x = d.radon.items[0];
    if (!d.radon.ok) R.push(nonObtenu(r, 'Géorisques (radon)'));
    else if (!x) { r.statut = 'non_concerne'; r.phrase = 'Potentiel radon non renseigné pour la commune.'; R.push(r); }
    else {
      const c = parseInt(x.classePotentiel, 10);
      r.statut = c === 3 ? 'concerne' : 'non_concerne';
      r.phrase = c === 3
        ? "Commune à potentiel radon de niveau 3 sur 3 : l'information est due."
        : `Potentiel radon de niveau ${c} sur 3 : seul le niveau 3 relève de l'obligation.`;
      r.donnees = [['Classe', `${c} sur 3`]];
      r.detail = ["Le radon est un gaz radioactif naturel issu du sous-sol. La cartographie nationale classe les communes en trois niveaux ; seul le niveau 3 déclenche l'obligation d'information. En niveau 3, une mesure dans les pièces de vie et, au besoin, des travaux d'aération sont recommandés."];
      if (c === 3) r.maximal = 'Potentiel radon de niveau 3, le plus élevé : mesurage recommandé dans les pièces de vie.';
      R.push(r);
    }
  }

  // -- 7° Recul du trait de cote — cascade a trois sources ----------------------
  {
    const r = base(7, 'trait_cote', 'Recul du trait de côte', 'IAL', 'L. 125-5 ; R. 125-23, 7° ; L. 121-22-2 code de l\'urbanisme');
    r.carte = COUCHES_SYNTHESE.trait_cote;
    const zertc = d.zertc.items.filter(p => String(p.typepsc) === '54');
    const prefig = d.infoSurf.items.filter(p => /pr[ée]figur|trait de c[ôo]te|recul/i.test(`${p.libelle || ''} ${p.txt || ''} ${p.typeinf || ''}`));
    const pprl = d.pprn.items.filter(e => /littoral|submersion|recul|[ée]rosion/i.test(e.libPpr || ''));
    if (!d.zertc.ok && !d.infoSurf.ok) R.push(nonObtenu(r, "Géoportail de l'urbanisme"));
    else if (zertc.length) {
      const horizons = zertc.map(p => String(p.stypepsc) === '01' ? '0 à 30 ans' : String(p.stypepsc) === '02' ? '30 à 100 ans' : 'horizon non précisé');
      r.statut = 'concerne';
      r.maximal = horizons.includes('0 à 30 ans') ? 'Bien dans une zone exposée au recul du trait de côte à horizon 30 ans : régime le plus contraignant (constructions limitées et démolition à terme).' : null;
      r.phrase = `Le bien est dans une zone exposée au recul du trait de côte délimitée au document d'urbanisme, horizon ${[...new Set(horizons)].join(' et ')}.`;
      r.donnees = [['Source', 'zone ZERTC du document d\'urbanisme (CNIG 54)'], ['Horizon', [...new Set(horizons)].join(' ; ')]];
      r.detail = ["Hiérarchie des sources : 1) les zones intégrées au document d'urbanisme priment toujours (code CNIG 54-01 : horizon 30 ans ; 54-02 : horizon 30 à 100 ans) ; 2) à défaut, la carte de préfiguration ; 3) à défaut, le PPR littoral. Les régimes diffèrent selon l'horizon : à 30 ans, constructions nouvelles interdites sauf exceptions et obligation de démolition à terme ; à 30-100 ans, constructions autorisées sous condition de démolition lorsque le recul le justifie."];
    } else if (prefig.length) {
      r.statut = 'concerne';
      r.phrase = "Le bien est couvert par une carte de préfiguration du recul du trait de côte, sans zone encore intégrée au document d'urbanisme.";
      r.donnees = [['Source', 'carte de préfiguration (pré-ZERTC)'], ['Mention', prefig[0].libelle || prefig[0].txt || '—']];
      r.detail = ["La carte de préfiguration anticipe l'intégration des zones au document d'urbanisme. Elle ne s'applique que si le territoire n'est pas déjà couvert par un PPR littoral approuvé comportant ce risque."];
    } else if (pprl.length) {
      r.statut = 'concerne';
      r.phrase = `Commune couverte par un plan de prévention littoral : « ${pprl[0].libPpr} ».`;
      r.donnees = [['Source', 'PPR littoral'], ['Plan', pprl.map(e => e.libPpr).join(' ; ')]];
      r.detail = ["En l'absence de zone délimitée au document d'urbanisme et de carte de préfiguration, le PPR littoral constitue la troisième source de la cascade."];
    } else {
      r.statut = 'non_concerne';
      r.phrase = com.is_coastline
        ? "Commune littorale, mais aucune zone de recul du trait de côte n'est délimitée au document d'urbanisme."
        : 'Commune non littorale : rubrique sans objet.';
      r.detail = com.is_coastline
        ? ["L'inscription d'une commune au décret du 29 avril 2022 modifié ne vaut pas délimitation ; l'absence peut aussi traduire un document d'urbanisme non encore actualisé. Point à vérifier auprès de la commune."]
        : ["La commune n'est pas identifiée comme littorale par le Géoportail de l'urbanisme."];
    }
    if (r.statut !== 'non_obtenu') R.push(r);
  }

  // -- 8° Debroussaillement -----------------------------------------------------
  {
    const r = base(8, 'old', 'Obligations légales de débroussaillement', 'IAL', 'L. 125-5 ; R. 125-23, 8° ; L. 134-6 code forestier');
    r.carte = COUCHES_SYNTHESE.old;
    const o = d.old.items[0];
    if (!d.old.ok) R.push(nonObtenu(r, 'Géorisques (OLD)'));
    else if (o) {
      r.statut = 'concerne';
      r.phrase = `Le bien est en zone soumise aux obligations légales de débroussaillement${o.departement ? ` (département ${o.departement})` : ''}.`;
      r.donnees = [['Département', o.departement || '—'], ['Fiche', o.url || 'georisques.gouv.fr']];
      r.detail = ["Depuis le 1er janvier 2025, la fiche d'information sur les obligations de débroussaillement doit être annexée à l'état des risques (R. 125-23, 8°). Le propriétaire doit débroussailler sur 50 mètres autour des constructions, distance pouvant être portée à 100 mètres par arrêté préfectoral."];
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = 'Aucune zone soumise aux obligations légales de débroussaillement ne couvre le bien.';
      r.detail = ["Le canal d'accès retenu est l'interface v2 de Géorisques, désignée par le 8° de R. 125-23 comme lieu de mise à disposition."];
      R.push(r);
    }
  }

  // -- 9 SIS -----------------------------------------------------------------------
  {
    const r = base(9, 'sis', "Secteur d'information sur les sols", 'Pollution des sols', 'L. 125-6 et L. 125-7 code de l\'environnement');
    r.carte = COUCHES_SYNTHESE.sis;
    const echelle = d.sis.source && d.sis.source.echelle === 'commune' ? 'commune' : 'parcelle';
    if (!d.sis.obtenu) R.push(nonObtenu(r, 'Géorisques (SIS)'));
    else if (d.sis.items.length) {
      const x = d.sis.items[0];
      r.statut = 'concerne';
      r.phrase = echelle === 'parcelle'
        ? `Le bien est inscrit dans un secteur d'information sur les sols : ${x.nom || x.nom_sis || x.libelle || 'secteur non dénommé'}.`
        : `${d.sis.items.length} secteur(s) d'information sur les sols recensé(s) sur la commune ; l'emprise exacte doit être vérifiée.`;
      r.donnees = [['Échelle de la donnée', echelle], ['Secteur', x.nom || x.nom_sis || x.libelle || '—'], ['Identifiant', x.id_sis || x.id || x.code || '—']];
      r.detail = ["Les secteurs d'information sur les sols (SIS) désignent les terrains où la connaissance de la pollution justifie, en cas de changement d'usage, une étude de sol et des mesures de gestion. Le vendeur ou le bailleur est tenu d'en informer par écrit l'acquéreur ou le locataire, et l'acte constate cette information (L. 125-7)."];
      if (echelle === 'parcelle') r.maximal = "Bien inscrit dans un secteur d'information sur les sols : information écrite obligatoire et étude de sol en cas de changement d'usage.";
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = echelle === 'parcelle' ? "Le bien n'est inscrit dans aucun secteur d'information sur les sols." : "Aucun secteur d'information sur les sols sur la commune.";
      r.detail = ["L'absence de SIS ne préjuge pas de l'absence de pollution : voir les rubriques ICPE et CASIAS."];
      R.push(r);
    }
  }

  // -- 10 ICPE ---------------------------------------------------------------------
  {
    const r = base(10, 'icpe', 'Installations classées (rayon 500 m)', 'Pollution des sols', 'L. 511-1 et suivants code de l\'environnement');
    r.carte = COUCHES_SYNTHESE.icpe;
    const retenues = icpeRetenues(d.icpe.items);
    if (!d.icpe.ok) R.push(nonObtenu(r, 'Géorisques (installations classées)'));
    else if (retenues.length) {
      r.statut = 'concerne';
      r.phrase = `${retenues.length} installation(s) classée(s) soumise(s) à autorisation ou enregistrement dans un rayon de 500 mètres.`;
      r.donnees = retenues.slice(0, 4).map(x => [x.regime || 'ICPE', `${x.raisonSociale || `établissement non dénommé (AIOT ${x.codeAIOT || 'inconnu'})`} — ${x.etatActivite || 'état non précisé'}`]);
      r.detail = [
        `Rayon de 500 mètres appliqué par la source depuis les limites de la parcelle. Les établissements de régime « Non ICPE » sont écartés (${d.icpe.items.length - retenues.length} sur ${d.icpe.items.length}).`,
        "La majorité des établissements de cette base ne porte pas de coordonnées individuelles mais celles du centre de la commune : aucune distance au bien n'est indiquée, plutôt qu'une distance fausse. Fiche par installation : georisques.gouv.fr/risques/installations/donnees/details/{identifiant}."
      ];
      r.table = { colonnes: ['Raison sociale', 'Régime', 'État'], largeurs: [250, 110, 120],
        lignes: retenues.slice(0, 40).map(x => [x.raisonSociale || `non dénommé (AIOT ${x.codeAIOT || '?'})`, x.regime || '—', x.etatActivite || 'non précisé']) };
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = 'Aucune installation soumise à autorisation ou enregistrement dans un rayon de 500 mètres.';
      r.detail = [`${d.icpe.items.length} établissement(s) recensé(s) dans le rayon, tous de régime « Non ICPE », donc écartés.`];
      R.push(r);
    }
  }

  // -- 11 CASIAS -------------------------------------------------------------------
  {
    const r = base(11, 'casias', 'Anciens sites industriels et activités de services (rayon 500 m)', 'Pollution des sols', 'L. 125-6 code de l\'environnement (inventaire historique)');
    r.carte = COUCHES_SYNTHESE.casias;
    const cas = d.casias.items;
    if (!d.casias.ok) R.push(nonObtenu(r, 'Géorisques (CASIAS)'));
    else if (cas.length) {
      const avec = cas.map(x => ({ x, m: distance(bien.centre, x.geom) })).sort((a, b) => (a.m ?? 1e9) - (b.m ?? 1e9));
      const proche = avec[0];
      r.statut = 'concerne';
      r.phrase = `${cas.length} ancien(s) site(s) industriel(s) ou de services recensé(s) dans un rayon de 500 mètres${proche.m !== null ? `, le plus proche à ${proche.m} m` : ''}.`;
      r.donnees = avec.slice(0, 4).map(({ x, m }) => [m === null ? 'non localisé' : `${m} m`, `${x.nom || x.activitePrincipale || 'site non dénommé'} — ${x.statut || 'statut non précisé'}`]);
      r.detail = [
        "L'inventaire CASIAS (ex-BASIAS) recense les sites ayant accueilli une activité potentiellement polluante, sans préjuger de l'existence d'une pollution. Fiche par site : fiches-risques.brgm.fr/georisques/casias/SSP{identifiant}.",
        "Le rayon est appliqué par la source depuis les limites de la parcelle ; les distances ci-dessus sont mesurées depuis son centroïde. Des valeurs supérieures à 500 mètres sont donc normales."
      ];
      r.table = { colonnes: ['Site', 'Statut', 'Distance'], largeurs: [270, 100, 80],
        lignes: avec.slice(0, 45).map(({ x, m }) => [x.nom || x.activitePrincipale || '—', x.statut || '—', m === null ? 'non localisé' : `${m} m`]) };
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = 'Aucun ancien site industriel ou de services recensé dans un rayon de 500 mètres.';
      r.detail = ["Inventaire CASIAS interrogé par référence cadastrale avec un rayon de 500 mètres."];
      R.push(r);
    }
  }

  // -- 12 Plan d'exposition au bruit ---------------------------------------------
  {
    const r = base(12, 'peb', "Plan d'exposition au bruit des aérodromes", 'Nuisances sonores aériennes', 'L. 112-6 et suivants, L. 112-11 code de l\'urbanisme');
    r.carte = COUCHES_SYNTHESE.peb;
    const motif = /bruit|\bpeb\b|a[ée]rodrome|a[ée]roport/i;
    const hits = [...d.supS.items, ...d.infoSurf.items].filter(p => motif.test(`${p.libelle || ''} ${p.nomsuplitt || ''} ${p.typeinf || ''} ${p.txt || ''} ${p.nomass || ''}`));
    if (!d.supS.ok && !d.infoSurf.ok) R.push(nonObtenu(r, "Géoportail de l'urbanisme"));
    else if (hits.length) {
      const h = hits[0];
      r.statut = 'concerne';
      r.phrase = `Le bien est concerné par un plan d'exposition au bruit : ${h.libelle || h.nomsuplitt || h.nomass || 'plan non dénommé'}.`;
      r.donnees = [['Mention au document d\'urbanisme', h.libelle || h.nomsuplitt || h.nomass || '—'], ['Zone', h.txt || h.typeinf || 'non précisée']];
      r.detail = ["Le plan d'exposition au bruit délimite quatre zones (A, B, C, D) autour des aérodromes. Dans les zones A à C, la constructibilité est limitée ; dans toutes les zones, le contrat de vente ou de location doit comporter une information sur la zone de bruit (L. 112-11). C'est un document distinct de l'état des risques."];
      r.maximal = /zone\s*A\b|\bA\b/.test(h.txt || '') ? "Bien en zone A du plan d'exposition au bruit : zone la plus exposée, constructibilité très limitée." : null;
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = "Aucun plan d'exposition au bruit identifié au document d'urbanisme pour le bien.";
      r.detail = ["Le plan d'exposition au bruit n'est pas une servitude d'utilité publique au sens strict et sa diffusion sur le Géoportail de l'urbanisme est inégale : l'absence ici doit être confirmée auprès de la commune si un aérodrome est proche. Aucun flux cartographique national n'existe pour cette rubrique ; la carte ci-contre situe simplement le bien."];
      R.push(r);
    }
  }

  // -- 13 Retrait-gonflement des argiles ----------------------------------------
  {
    const r = base(13, 'rga', 'Retrait-gonflement des sols argileux', 'Information complémentaire', 'L. 132-4 à L. 132-9 code de la construction et de l\'habitation (loi ELAN)');
    r.carte = COUCHES_SYNTHESE.rga;
    const x = d.rga.items[0];
    if (!d.rga.ok) R.push(nonObtenu(r, 'Géorisques (RGA)'));
    else if (x) {
      const c = parseInt(x.codeExposition, 10);
      r.statut = c >= 1 ? 'concerne' : 'non_concerne';
      r.phrase = c >= 1
        ? `Exposition ${x.exposition} au retrait-gonflement des argiles (niveau ${c} sur 3)${c >= 2 ? ' : étude géotechnique préalable obligatoire avant construction' : ''}.`
        : 'Exposition nulle ou non cartographiée au retrait-gonflement des argiles.';
      r.donnees = [['Exposition', `${x.exposition} (${c} sur 3)`]];
      r.detail = ["Hors périmètre de l'obligation IAL, mais retenu pour son intérêt pratique : en zone d'exposition moyenne ou forte, une étude géotechnique préalable est obligatoire à la vente d'un terrain constructible et avant tout projet de construction (loi ELAN). Les sinistres « sécheresse » relèvent du régime des catastrophes naturelles."];
      if (c === 3) r.maximal = 'Exposition forte au retrait-gonflement des argiles, niveau le plus élevé : étude géotechnique obligatoire et vigilance sur les fissurations.';
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = 'Aucune exposition au retrait-gonflement des argiles cartographiée pour le bien.';
      r.detail = ["Cartographie nationale de l'exposition au retrait-gonflement des argiles (BRGM)."];
      R.push(r);
    }
  }

  // -- 14 Remontee de nappe ---------------------------------------------------------
  {
    const r = base(14, 'nappe', 'Remontée de nappe', 'Information complémentaire', 'inventaire BRGM, hors obligation réglementaire');
    r.carte = COUCHES_SYNTHESE.nappe;
    if (!d.nappe.obtenu) R.push(nonObtenu(r, 'Géorisques / BRGM (remontée de nappe)'));
    else if (d.nappe.items.length) {
      const x = d.nappe.items[0];
      const sens = x.sensibilite || x.classe || x.libelle || x.niveau || x.type || premiereValeur(x);
      r.statut = 'concerne';
      r.phrase = `Le bien est en zone sensible aux remontées de nappe : ${sens || 'sensibilité non qualifiée par la source'}.`;
      r.donnees = paires(x, 5);
      r.detail = ["La cartographie des remontées de nappe distingue les zones potentiellement sujettes aux débordements de nappe et aux inondations de cave. Elle est indicative et ne se substitue pas à une étude hydrogéologique. Source retenue : " + (d.nappe.source ? d.nappe.source.libelle : '—') + '.'];
      if (/tr[èe]s\s+forte|d[ée]bordement|forte/i.test(String(sens))) r.maximal = `Sensibilité forte aux remontées de nappe : ${sens}.`;
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = 'Le bien est hors des zones sensibles aux remontées de nappe cartographiées.';
      r.detail = ['Source interrogée : ' + (d.nappe.source ? d.nappe.source.libelle : '—') + '.'];
      R.push(r);
    }
  }

  // -- 15 Canalisations ----------------------------------------------------------------
  {
    const r = base(15, 'canalisations', 'Canalisations de transport de matières dangereuses', 'Information complémentaire', 'L. 555-1 et suivants code de l\'environnement');
    r.carte = COUCHES_SYNTHESE.canalisations;
    if (!d.canalisations.obtenu) R.push(nonObtenu(r, 'Géorisques (canalisations)'));
    else if (d.canalisations.items.length) {
      const x = d.canalisations.items[0];
      const echelle = d.canalisations.source && d.canalisations.source.echelle === 'commune' ? 'sur la commune' : 'à proximité du bien';
      r.statut = 'concerne';
      r.phrase = `${d.canalisations.items.length} canalisation(s) de transport de matières dangereuses recensée(s) ${echelle}.`;
      r.donnees = paires(x, 5);
      r.detail = ["Gaz, hydrocarbures ou produits chimiques transportés par canalisation enterrée. Les servitudes d'utilité publique associées (SUP1 à SUP3) limitent l'implantation d'établissements recevant du public et imposent une information des maîtres d'ouvrage. Source retenue : " + (d.canalisations.source ? d.canalisations.source.libelle : '—') + '.'];
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = 'Aucune canalisation de transport de matières dangereuses recensée à proximité du bien.';
      r.detail = ['Source interrogée : ' + (d.canalisations.source ? d.canalisations.source.libelle : '—') + '.'];
      R.push(r);
    }
  }

  // -- 16 Arretes CatNat (carte communale) --------------------------------------------
  {
    const r = base(16, 'catnat', "Arrêtés de reconnaissance de l'état de catastrophe naturelle", 'Sinistralité', 'L. 125-1 code des assurances ; R. 125-24, 5° code de l\'environnement');
    r.carte = { ...COUCHES_SYNTHESE.catnat, echelle: 'commune' };
    const items = d.catnat.items;
    if (!d.catnat.ok) R.push(nonObtenu(r, 'Géorisques (CatNat, v1)'));
    else if (items.length) {
      const annee = new Date().getFullYear();
      const recents = items.filter(a => Math.floor(cleDate(a.date_debut_evt) / 10000) >= annee - 10);
      const groupes = {};
      for (const a of items) { const k = a.libelle_risque_jo || 'Non précisé'; (groupes[k] = groupes[k] || []).push(a); }
      const tri = Object.entries(groupes).sort((a, b) => b[1].length - a[1].length);
      r.statut = 'concerne';
      r.phrase = `${items.length} arrêté(s) sur la commune depuis 1982, dont ${recents.length} au cours des dix dernières années ; aléa dominant : ${tri[0][0].toLowerCase()} (${tri[0][1].length}).`;
      r.donnees = tri.slice(0, 5).map(([k, v]) => [k, `${v.length} arrêté(s)`]);
      r.detail = ["Seule donnée rétrospective du rapport, à l'échelle de la COMMUNE et non de la parcelle : elle éclaire la sinistralité du territoire, pas l'exposition propre du bien. Source : Caisse centrale de réassurance. La liste complète, sans troncature, figure dans l'état des risques (R. 125-24, 5°) ; ci-après, la liste intégrale groupée par aléa."];
      r.table = { colonnes: ['Aléa', 'Début', 'Fin', 'Arrêté du', 'JO du'], largeurs: [175, 70, 70, 80, 70],
        lignes: items.slice().sort((x, y) => cleDate(y.date_debut_evt) - cleDate(x.date_debut_evt))
                     .map(a => [a.libelle_risque_jo || '—', a.date_debut_evt, a.date_fin_evt, a.date_publication_arrete, a.date_publication_jo]) };
      R.push(r);
    } else {
      r.statut = 'non_concerne';
      r.phrase = "Aucun arrêté de reconnaissance de l'état de catastrophe naturelle n'a été pris sur la commune.";
      r.detail = ['Base GASPAR interrogée par code INSEE, sans limitation de profondeur.'];
      R.push(r);
    }
  }

  return R.sort((a, b) => a.numero - b.numero);
}

function base(numero, cle, intitule, regime, fondement) {
  return { numero, cle, intitule, regime, fondement, statut: 'non_concerne', phrase: '', donnees: [], detail: [], carte: null, maximal: null, table: null };
}

function nonObtenu(r, source) {
  r.statut = 'non_obtenu';
  r.phrase = `Donnée non obtenue : la source ${source} n'a pas répondu à la date d'établissement. Rubrique à compléter.`;
  r.detail = [`La source ${source} n'a pas répondu. La génération n'a pas été bloquée ; ce rapport n'est pas régénéré automatiquement, une nouvelle édition doit être demandée.`];
  return r;
}

// Couche cartographique selon la nature du plan : superposer le zonage
// inondation sur un PPR mouvement de terrain n'aurait aucun sens.
function coucheDuPlan(cle, e) {
  if (cle === 'pprt') return COUCHES_SYNTHESE.pprt;
  if (cle === 'pprm') return COUCHES_SYNTHESE.pprm;
  const lib = String((e || {}).libPpr || '').toLowerCase();
  if (/mouvement|glissement|effondrement|cavit/.test(lib)) return COUCHES_SYNTHESE.pprn_mvt;
  if (/submersion|littoral/.test(lib)) return { service: WMS_RISQUES, couche: 'PPRN_ZONE_SUBMAR' };
  if (/feu|incendie/.test(lib)) return { service: WMS_RISQUES, couche: 'PPRN_ZONE_FEU' };
  if (/avalanche/.test(lib)) return { service: WMS_RISQUES, couche: 'PPRN_ZONE_AVALANCHE' };
  if (/s[ée]isme/.test(lib)) return { service: WMS_RISQUES, couche: 'PPRN_ZONE_SEISME' };
  return COUCHES_SYNTHESE.pprn;
}

// Le niveau « maximal » d'un zonage de PPR se lit dans le libelle de la
// zone : rouge, fort, inconstructible, interdit. Heuristique documentee,
// pas verite reglementaire — l'annexe renvoie toujours au reglement.
function zoneMaximale(zones, motCle) {
  const z = zones.find(t => /rouge|\bfort|inconstructible|interdit|tr[èe]s\s+fort/i.test(t));
  return z ? `Bien en zone la plus contraignante du ${motCle} (${z}) : constructibilité très limitée ou interdite, prescriptions renforcées.` : null;
}

function paires(obj, n) {
  return Object.entries(obj || {})
    .filter(([k, v]) => v !== null && v !== undefined && typeof v !== 'object' && !/^(geom|id|uuid|the_geom|bbox)$/i.test(k))
    .slice(0, n)
    .map(([k, v]) => [k.replace(/_/g, ' '), String(v)]);
}

function premiereValeur(obj) {
  const p = paires(obj, 1)[0];
  return p ? p[1] : null;
}

function sources(d, horodatage) {
  const quand = horodatage.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  const etat = ok => ok ? 'réponse obtenue' : 'sans réponse';
  return [
    ['Géorisques, interface v2 (zonage sismique, radon, OLD, PPR, RGA, CASIAS, ICPE)', `interrogée par référence cadastrale le ${quand} — ${etat(d.sismique.ok && d.radon.ok && d.old.ok && d.pprn.ok && d.rga.ok && d.casias.ok && d.icpe.ok)}`],
    ['Géorisques, interface v1 (arrêtés CatNat, source CCR)', `interrogée par code INSEE le ${quand} — ${etat(d.catnat.ok)}`],
    ["Géoportail de l'urbanisme, module GPU d'API Carto (commune, document, zonage, prescriptions, informations, servitudes)", `interrogé par géométrie parcellaire le ${quand} — ${etat(d.commune.ok && d.zertc.ok && d.supS.ok)}`],
    ['Secteurs d\'information sur les sols', d.sis.obtenu ? `${d.sis.source.libelle} — ${quand}` : `aucun candidat n'a répondu le ${quand}`],
    ['Remontée de nappe', d.nappe.obtenu ? `${d.nappe.source.libelle} — ${quand}` : `aucun candidat n'a répondu le ${quand}`],
    ['Canalisations de matières dangereuses', d.canalisations.obtenu ? `${d.canalisations.source.libelle} — ${quand}` : `aucun candidat n'a répondu le ${quand}`],
    ['Directive inondation (TRI)', d.tri.obtenu ? `${d.tri.source.libelle} — ${quand}` : `aucun candidat n'a répondu le ${quand}`],
    ['Géométrie de la parcelle', `API Carto de l'IGN, module cadastre — ${quand}`],
    ['Adresse postale', `Base adresse nationale, géocodage inverse — ${quand}`],
    ['Fonds cartographiques', 'Géoplateforme IGN (plan, orthophotographie, parcellaire) et flux Géorisques/BRGM (zonages), régénérés à chaque édition'],
    ['Note', "Les sources ne publient pas de date de mise à jour par base dans leurs interfaces ; la date indiquée est celle de l'interrogation. Les dates de publication des arrêtés et des plans figurent en annexe."]
  ];
}

// ===========================================================================
// RENDU
// ===========================================================================
async function composer({ ref, dossier, bien, adresse, donnees, rubriques, horodatage, avecCartes }) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const serif  = await doc.embedFont(police('GELASIO_REGULAR'));
  const serifG = await doc.embedFont(police('GELASIO_BOLD'));
  const sans   = await doc.embedFont(police('SANS_REGULAR'));
  const sansG  = await doc.embedFont(police('SANS_BOLD'));
  const F = { serif, serifG, sans, sansG };

  const dateLongue = horodatage.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const libAdresse = adresse ? adresse.libelle : libelleCommune(donnees);
  const e = { doc, F, pages: [], page: null, y: 0, ref, dossier, adresse: libAdresse, date: dateLongue, liens: [], ancres: {} };

  // Toutes les images sont chargees EN PARALLELE avant le rendu : seize
  // cartes a deux couches chacune, plus les trois vues de la garde.
  const marge = margeAdaptee(bien.contenance);
  const cartes = avecCartes ? await chargerCartes(bien, rubriques, marge) : null;

  // --- Page de garde --------------------------------------------------------
  nouvellePage(e);
  titre(e, 'RAPPORT DE SYNTHÈSE — RISQUES', 20, serifG);
  titre(e, 'seize rubriques, y compris celles où le bien n\'est pas concerné', 12.5, serif, CANARD);
  e.y -= 10; filet(e); e.y -= 14;
  paragraphe(e, `Établi le ${dateLongue}.`, 10, sansG);
  e.y -= 4;
  paragraphe(e, "Document de conseil destiné au dossier, distinct de l'état des risques annexé à l'acte. Il n'est pas signé par les parties et n'est pas opposable : c'est un outil de travail pour le collaborateur et une aide à l'analyse pour le client. Il ne porte pas de durée de validité ; il doit être réédité si la situation évolue.", 9.5, sans, GRIS);
  e.y -= 12;
  encadre(e, [['Adresse', libAdresse], ['Référence cadastrale', ref], ['Contenance', `${bien.contenance || '—'} m²`], ['Dossier', dossier || '—']]);

  if (cartes) {
    e.y -= 14;
    // Plan cadastral, parcelle colorisee en carmin
    await vue(e, cartes.garde.plan, UTILE, Math.round(UTILE * 0.56), bien, cartes.garde.bboxPlan, { remplir: true, legende: 'Extrait du plan cadastral — parcelle colorisée en carmin' });
    e.y -= 8;
    // Deux petites vues cote a cote : aerienne et situation communale
    const petite = { l: CELL_L, h: Math.round(CELL_L * 0.62) };
    const yHaut = e.y;
    await vue(e, cartes.garde.ortho, petite.l, petite.h, bien, cartes.garde.bboxPlan, { legende: 'Vue aérienne' });
    const yBas = e.y;
    e.y = yHaut;
    await vue(e, cartes.garde.commune, petite.l, petite.h, bien, cartes.garde.bboxCommune, { x: MARGE.g + CELL_L + GOUTTIERE, croix: true, legende: 'Situation sur le plan communal' });
    e.y = Math.min(yBas, e.y);
  }

  // --- Encadre de tete : seulement si un risque atteint son niveau maximal ----
  const saillants = rubriques.filter(r => r.maximal);
  nouvellePage(e);
  if (saillants.length) {
    section(e, "Points saillants");
    paragraphe(e, "Seuls figurent ici les risques qui atteignent le niveau le plus élevé de leur propre échelle. Les autres sont à leur place, dans l'ordre réglementaire.", 9, sans, GRIS);
    e.y -= 6;
    for (const r of saillants) {
      place(e, 40);
      const lignes = decouper(r.maximal, sans, 9.5, UTILE - 24);
      const h = 18 + lignes.length * 13.5;
      e.page.drawRectangle({ x: MARGE.g, y: e.y - h, width: UTILE, height: h, color: FOND, borderColor: CARMIN, borderWidth: 0.8 });
      e.page.drawRectangle({ x: MARGE.g, y: e.y - h, width: 4, height: h, color: CARMIN });
      e.page.drawText(`${r.numero}. ${r.intitule}`, { x: MARGE.g + 12, y: e.y - 13, size: 9.5, font: sansG, color: CARMIN });
      let yy = e.y - 27;
      for (const l of lignes) { e.page.drawText(l, { x: MARGE.g + 12, y: yy, size: 9.5, font: sans, color: NUIT }); yy -= 13.5; }
      e.y -= h + 8;
    }
    e.y -= 10;
  }

  // --- Corps : quatre triptyques par page ---------------------------------------
  section(e, "Les seize rubriques");
  paragraphe(e, "Pour chacune : une phrase de synthèse, les données attachées et la carte situant le bien en regard du risque. La carte est présente même hors zonage : elle sert de double vérification entre les données et les plans. Le détail réglementaire figure en annexe, atteint par le lien sous chaque carte.", 9, sans, GRIS);
  e.y -= 10;

  const HAUTEUR_CELL = CARTE_H + 118;
  for (let i = 0; i < rubriques.length; i += 2) {
    place(e, HAUTEUR_CELL);
    const yDebut = e.y;
    let yMin = e.y;
    for (let k = 0; k < 2 && i + k < rubriques.length; k++) {
      const r = rubriques[i + k];
      const x = MARGE.g + k * (CELL_L + GOUTTIERE);
      e.y = yDebut;
      await cellule(e, r, x, bien, cartes ? cartes.rubriques[r.numero] : null, marge);
      yMin = Math.min(yMin, e.y);
    }
    e.y = yMin - 12;
  }

  // --- Annexe de detail, meme ordre -----------------------------------------------
  nouvellePage(e);
  section(e, 'Annexe — Détail par rubrique');
  paragraphe(e, "Références juridiques, données complètes et listes. L'ordre est celui des rubriques du corps.", 9, sans, GRIS);
  e.y -= 8;
  for (const r of rubriques) {
    place(e, 60);
    e.ancres[r.numero] = { page: e.page, y: e.y + 6 };
    barreRubrique(e, r, UTILE, MARGE.g, 10.5);
    e.y -= 4;
    paragraphe(e, `Fondement : ${r.fondement}. Régime : ${r.regime}.`, 8.5, sans, GRIS);
    e.y -= 3;
    paragraphe(e, r.phrase, 9.5, serif, r.statut === 'concerne' ? CARMIN : NUIT);
    e.y -= 3;
    for (const [k, v] of r.donnees) {
      place(e, 14);
      e.page.drawText(`${k} :`, { x: MARGE.g + 8, y: e.y - 9, size: 8.5, font: sansG, color: GRIS });
      const wk = sansG.widthOfTextAtSize(`${k} :`, 8.5) + 12;
      const lignes = decouper(v, sans, 8.5, UTILE - 8 - wk);
      e.page.drawText(lignes[0] || '', { x: MARGE.g + 8 + wk, y: e.y - 9, size: 8.5, font: sans, color: NUIT });
      e.y -= 12;
      for (const l of lignes.slice(1)) { place(e, 12); e.page.drawText(l, { x: MARGE.g + 8 + wk, y: e.y - 9, size: 8.5, font: sans, color: NUIT }); e.y -= 12; }
    }
    if (r.donnees.length) e.y -= 4;
    for (const p of r.detail) { paragraphe(e, p, 8.5, sans, NUIT); e.y -= 3; }
    if (r.table) {
      e.y -= 4;
      entete(e, r.table.colonnes, r.table.largeurs);
      for (const l of r.table.lignes) rangee(e, l, r.table.largeurs);
    }
    e.y -= 14;
  }

  // --- Sources ---------------------------------------------------------------------
  e.y -= 6;
  sousSection(e, 'Bases interrogées');
  for (const [k, v] of sources(donnees, horodatage)) {
    paragraphe(e, `${k} — ${v}`, 8.5, sans, GRIS);
    e.y -= 2;
  }
  e.y -= 8;
  paragraphe(e, "Composition : Gelasio et Open Sans, substituts libres de Georgia et Segoe UI. La qualification applique les seuils de l'article R. 125-23 : sismicité à partir de la zone 2, radon au seul niveau 3, plans de prévention seulement si une zone délimitée couvre le bien ; les rubriques hors obligation sont restituées telles que publiées.", 8, sans, GRIS);

  pieds(e);
  poserLiens(e);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Une cellule du corps : carte, barre de titre, phrase, lien vers l'annexe
// ---------------------------------------------------------------------------
async function cellule(e, r, x, bien, imgs, marge) {
  const yHaut = e.y;
  const communal = r.carte && r.carte.echelle === 'commune';

  // Carte
  if (imgs) {
    try {
      if (imgs.fond) {
        const img = await e.doc.embedJpg(imgs.fond);
        e.page.drawImage(img, { x, y: yHaut - CARTE_H, width: CELL_L, height: CARTE_H });
      }
      if (imgs.sur) {
        const img = await e.doc.embedPng(imgs.sur);
        e.page.drawImage(img, { x, y: yHaut - CARTE_H, width: CELL_L, height: CARTE_H, opacity: 0.6 });
      }
    } catch (err) {
      e.page.drawText(`Cartographie indisponible : ${err.message}`.slice(0, 60), { x: x + 6, y: yHaut - 16, size: 7.5, font: e.F.sans, color: CARMIN });
    }
    if (!communal) contour(e, bien, imgs.bbox, x, yHaut - CARTE_H, CELL_L, CARTE_H, false);
    croix(e, bien, imgs.bbox, x, yHaut - CARTE_H, CELL_L, CARTE_H);
  } else {
    e.page.drawRectangle({ x, y: yHaut - CARTE_H, width: CELL_L, height: CARTE_H, color: FOND });
    e.page.drawText('Cartographie désactivée (cartes=0)', { x: x + 8, y: yHaut - CARTE_H / 2, size: 8, font: e.F.sans, color: GRIS });
  }
  e.page.drawRectangle({ x, y: yHaut - CARTE_H, width: CELL_L, height: CARTE_H, borderColor: GRIS, borderWidth: 0.6 });

  // Legende de la carte
  const emp = communal ? MARGE_COMMUNALE * 2 : marge * 2;
  let leg = `Emprise ${emp >= 1000 ? `${(emp / 1000).toFixed(1).replace('.0', '')} km` : `${emp} m`}`;
  if (!r.carte || !r.carte.couche) leg += ' — aucune couche nationale : carte de situation';
  else if (imgs && imgs.sur === null) leg += ` — couche ${r.carte.couche} non obtenue`;
  else leg += ` — couche ${r.carte ? r.carte.couche : ''}`;
  e.page.drawText(tronquer(leg, e.F.sans, 6.8, CELL_L), { x, y: yHaut - CARTE_H - 9, size: 6.8, font: e.F.sans, color: GRIS });

  // Barre de titre
  e.y = yHaut - CARTE_H - 14;
  barreRubrique(e, r, CELL_L, x, 8.5);
  e.y -= 3;

  // Phrase de synthese, quatre lignes au plus
  const couleur = r.statut === 'concerne' ? CARMIN : r.statut === 'non_obtenu' ? NUIT : GRIS;
  const lignes = decouper(r.phrase, e.F.serif, 8.5, CELL_L - 4);
  const visibles = lignes.slice(0, 4);
  if (lignes.length > 4) visibles[3] = tronquer(visibles[3] + ' …', e.F.serif, 8.5, CELL_L - 4);
  if (r.statut === 'non_obtenu') {
    e.page.drawRectangle({ x, y: e.y - visibles.length * 12 - 2, width: CELL_L, height: visibles.length * 12 + 4, color: JAUNE_PALE });
  }
  for (const l of visibles) {
    e.page.drawText(l, { x: x + 2, y: e.y - 9, size: 8.5, font: e.F.serif, color: couleur });
    e.y -= 12;
  }
  e.y -= 2;

  // Lien vers l'annexe
  const texte = 'Détail en annexe';
  const w = e.F.sansG.widthOfTextAtSize(texte, 7.5);
  e.page.drawText(texte, { x: x + 2, y: e.y - 8, size: 7.5, font: e.F.sansG, color: CANARD });
  e.page.drawLine({ start: { x: x + 2, y: e.y - 10 }, end: { x: x + 2 + w, y: e.y - 10 }, thickness: 0.5, color: CANARD });
  e.liens.push({ page: e.page, rect: [x, e.y - 12, x + w + 4, e.y], numero: r.numero });
  e.y -= 14;
}

function barreRubrique(e, r, largeur, x, taille) {
  const h = taille + 9;
  const fond = r.statut === 'non_obtenu' ? JAUNE : NUIT;
  const encre = r.statut === 'non_obtenu' ? NUIT : BLANC;
  place(e, h + 2);
  e.page.drawRectangle({ x, y: e.y - h, width: largeur, height: h, color: fond });
  const num = `${r.numero}.`;
  e.page.drawText(num, { x: x + 6, y: e.y - h + 6, size: taille, font: e.F.sansG, color: r.statut === 'non_obtenu' ? NUIT : JAUNE });
  const wn = e.F.sansG.widthOfTextAtSize(num, taille) + 10;
  const etiquette = r.statut === 'concerne' ? 'concerné' : r.statut === 'non_obtenu' ? 'non obtenu' : 'non concerné';
  const we = e.F.sans.widthOfTextAtSize(etiquette, taille - 1.5);
  e.page.drawText(tronquer(r.intitule, e.F.sansG, taille, largeur - wn - we - 18), { x: x + wn, y: e.y - h + 6, size: taille, font: e.F.sansG, color: encre });
  e.page.drawText(etiquette, { x: x + largeur - we - 6, y: e.y - h + 6, size: taille - 1.5, font: e.F.sans, color: r.statut === 'concerne' ? JAUNE : encre });
  e.y -= h;
}

// ---------------------------------------------------------------------------
// Cartes : chargement en parallele, puis dessin
// ---------------------------------------------------------------------------
async function chargerCartes(bien, rubriques, marge) {
  const bboxPlan = emprise(bien.centre, Math.max(60, Math.round(marge * 0.6)), { l: 900, h: Math.round(900 * 0.56) });
  const bboxCommune = emprise(bien.centre, MARGE_COMMUNALE, PX);
  const bboxRub = emprise(bien.centre, marge, PX);

  const taches = [];
  const garde = { bboxPlan, bboxCommune };
  taches.push(image(getMap(WMS_IGN, 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', bboxPlan, { l: 900, h: Math.round(900 * 0.56) }, false)).then(b => { garde.plan = { fond: b, sur: null }; }).catch(() => { garde.plan = { fond: null, sur: null }; }));
  taches.push(image(getMap(WMS_IGN, 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS', bboxPlan, { l: 900, h: Math.round(900 * 0.56) }, true)).then(b => { garde.plan.sur = b; }).catch(() => {}));
  taches.push(image(getMap(WMS_IGN, 'HR.ORTHOIMAGERY.ORTHOPHOTOS', bboxPlan, { l: 900, h: Math.round(900 * 0.56) }, false)).then(b => { garde.ortho = { fond: b, sur: null }; }).catch(() => { garde.ortho = { fond: null, sur: null }; }));
  taches.push(image(getMap(WMS_IGN, 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', bboxCommune, PX, false)).then(b => { garde.commune = { fond: b, sur: null }; }).catch(() => { garde.commune = { fond: null, sur: null }; }));

  const parRubrique = {};
  for (const r of rubriques) {
    const communal = r.carte && r.carte.echelle === 'commune';
    const bbox = communal ? bboxCommune : bboxRub;
    parRubrique[r.numero] = { fond: null, sur: null, bbox };
    taches.push(image(getMap(WMS_IGN, 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', bbox, PX, false)).then(b => { parRubrique[r.numero].fond = b; }).catch(() => {}));
    if (r.carte && r.carte.couche) {
      taches.push(image(getMap(r.carte.service, r.carte.couche, bbox, PX, true)).then(b => { parRubrique[r.numero].sur = b; }).catch(() => {}));
    }
  }
  await Promise.all(taches);
  // Le plan de la garde se charge en deux temps ; si le fond a echoue avant
  // que la superposition n'arrive, l'objet peut manquer.
  garde.plan = garde.plan || { fond: null, sur: null };
  garde.ortho = garde.ortho || { fond: null, sur: null };
  garde.commune = garde.commune || { fond: null, sur: null };
  return { garde, rubriques: parRubrique };
}

async function vue(e, imgs, largeur, hauteur, bien, bbox, opt = {}) {
  const x = opt.x ?? MARGE.g;
  place(e, hauteur + 22);
  const yBas = e.y - hauteur;
  try {
    if (imgs && imgs.fond) {
      const img = await e.doc.embedJpg(imgs.fond);
      e.page.drawImage(img, { x, y: yBas, width: largeur, height: hauteur });
    }
    if (imgs && imgs.sur) {
      const img = await e.doc.embedPng(imgs.sur);
      e.page.drawImage(img, { x, y: yBas, width: largeur, height: hauteur, opacity: 0.85 });
    }
  } catch (err) {
    e.page.drawText(`Vue indisponible : ${err.message}`.slice(0, 70), { x: x + 6, y: e.y - 16, size: 8, font: e.F.sans, color: CARMIN });
  }
  if (opt.croix) croix(e, bien, bbox, x, yBas, largeur, hauteur);
  else contour(e, bien, bbox, x, yBas, largeur, hauteur, !!opt.remplir);
  e.page.drawRectangle({ x, y: yBas, width: largeur, height: hauteur, borderColor: GRIS, borderWidth: 0.6 });
  e.y -= hauteur + 4;
  if (opt.legende) {
    e.page.drawText(tronquer(opt.legende, e.F.sans, 7.5, largeur), { x, y: e.y - 8, size: 7.5, font: e.F.sans, color: GRIS });
    e.y -= 14;
  }
}

// Contour parcellaire en vecteur ; avec remplissage carmin translucide sur la
// page de garde (« parcelle colorisee en carmin »).
function contour(e, bien, bbox, x, yBas, largeur, hauteur, remplir) {
  for (const anneau of (bien.anneaux || [])) {
    if (remplir && anneau.length > 2) {
      const pts = anneau.map(p => projeter(p, bbox, largeur, hauteur));
      const chemin = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${(hauteur - p.y).toFixed(2)}`).join(' ') + ' Z';
      e.page.drawSvgPath(chemin, { x, y: yBas + hauteur, color: CARMIN, opacity: 0.38 });
    }
    for (let i = 0; i < anneau.length - 1; i++) {
      const a = projeter(anneau[i], bbox, largeur, hauteur);
      const b = projeter(anneau[i + 1], bbox, largeur, hauteur);
      e.page.drawLine({
        start: { x: x + a.x, y: yBas + a.y }, end: { x: x + b.x, y: yBas + b.y },
        thickness: remplir ? 1.6 : 1.2, color: CARMIN
      });
    }
  }
}

// Repere en croix au centre de la parcelle, sur le modele de MARTEAU : deux
// traits carmin ouverts au centre, pour ne pas masquer le bien.
function croix(e, bien, bbox, x, yBas, largeur, hauteur) {
  const c = projeter([bien.centre.lon, bien.centre.lat], bbox, largeur, hauteur);
  const cx = x + c.x, cy = yBas + c.y;
  const bras = 14, trou = 5;
  const trait = (x1, y1, x2, y2) => e.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1.4, color: CARMIN });
  trait(cx - bras, cy, cx - trou, cy); trait(cx + trou, cy, cx + bras, cy);
  trait(cx, cy - bras, cx, cy - trou); trait(cx, cy + trou, cx, cy + bras);
  e.page.drawCircle({ x: cx, y: cy, size: trou, borderColor: CARMIN, borderWidth: 1.2 });
}

// ---------------------------------------------------------------------------
// Liens internes : du corps vers l'annexe
// ---------------------------------------------------------------------------
function poserLiens(e) {
  for (const l of e.liens) {
    const cible = e.ancres[l.numero];
    if (!cible) continue;
    const dest = e.doc.context.obj([cible.page.ref, 'XYZ', null, cible.y, null]);
    const annot = e.doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: l.rect, Border: [0, 0, 0], Dest: dest
    });
    const ref = e.doc.context.register(annot);
    let annots = l.page.node.lookup(PDFName.of('Annots'));
    if (!annots) {
      annots = e.doc.context.obj([]);
      l.page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
  }
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
  e.page.drawLine({ start: { x: MARGE.g, y: e.y }, end: { x: PAGE.l - MARGE.d, y: e.y }, thickness: 0.7, color: GRIS });
  e.y -= 4;
}

function decouper(texte, fonte, taille, largeur) {
  const mots = String(texte ?? '').replace(/\s+/g, ' ').trim().split(' ');
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

function tronquer(texte, fonte, taille, largeur) {
  let t = String(texte ?? '');
  if (fonte.widthOfTextAtSize(t, taille) <= largeur) return t;
  while (t.length > 3 && fonte.widthOfTextAtSize(t + '…', taille) > largeur) t = t.slice(0, -1);
  return t.trimEnd() + '…';
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

function encadre(e, lignes) {
  const hauteur = lignes.length * 17 + 16;
  place(e, hauteur);
  e.page.drawRectangle({ x: MARGE.g, y: e.y - hauteur, width: UTILE, height: hauteur, color: FOND, borderColor: GRIS, borderWidth: 0.6 });
  let y = e.y - 20;
  for (const [k, v] of lignes) {
    e.page.drawText(k, { x: MARGE.g + 14, y, size: 9, font: e.F.sans, color: GRIS });
    e.page.drawText(tronquer(v, e.F.sansG, 9.5, UTILE - 190), { x: MARGE.g + 168, y, size: 9.5, font: e.F.sansG, color: NUIT });
    y -= 17;
  }
  e.y -= hauteur;
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
    e.page.drawText(tronquer(v ?? '—', e.F.sans, 7.5, largeurs[i] - 8), { x, y: e.y - 8, size: 7.5, font: e.F.sans, color: NUIT });
    x += largeurs[i];
  });
  e.y -= 12;
}

// Pied de page : adresse du bien, date d'etablissement, pagination — pour
// qu'une page detachee reste identifiable.
function pieds(e) {
  const total = e.pages.length;
  e.pages.forEach((p, i) => {
    const gauche = tronquer(`${e.dossier ? `${e.dossier} — ` : ''}${e.adresse} — ${e.ref}`, e.F.sans, 7.5, UTILE - 140);
    p.drawLine({ start: { x: MARGE.g, y: MARGE.bas - 18 }, end: { x: PAGE.l - MARGE.d, y: MARGE.bas - 18 }, thickness: 0.5, color: GRIS });
    p.drawText(gauche, { x: MARGE.g, y: MARGE.bas - 32, size: 7.5, font: e.F.sans, color: GRIS });
    const droite = `Rapport du ${e.date} — ${i + 1} / ${total}`;
    const w = e.F.sans.widthOfTextAtSize(droite, 7.5);
    p.drawText(droite, { x: PAGE.l - MARGE.d - w, y: MARGE.bas - 32, size: 7.5, font: e.F.sans, color: GRIS });
  });
}
