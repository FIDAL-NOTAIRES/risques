// RISQUES — /api/portefeuille.mjs (13/10/2026)
//
// PORTEFEUILLE EN MODE DIFFÉRÉ — arbitrages des 14, 15 et 16/09/2026, choix techniques
// validés par JFD le 13/10/2026.
//
//   POST /api/portefeuille      corps JSON :
//        { societe, appelant, dossier,
//          groupes: [ { numero, parcelles: ["62160-000-XM-0307", …] }, … ] }
//        (ou, en appli autonome, { societe, parcelles: [ … ] } : une parcelle par bien,
//         retriée par commune, section, numéro)
//      → 202 { travail, interroger, statut: "en_cours" }  — aucun PDF, tout de suite
//
//   GET  /api/portefeuille?parcelles=…,…&societe=…   même commande, par simple adresse
//   GET  /api/portefeuille?travail=…   (l'APPELANT interroge ; RISQUES ne rappelle jamais)
//      → { statut: "en_cours", phase, fait, total, message }   tant que ce n'est pas fini
//      → { statut: "termine", rapport, erps: [{numero, url}], expire_le }
//      → 410 { statut: "expire" } passé trente jours
//
// Mécanique : chaque interrogation fait avancer le travail d'une TRANCHE (≈ 40 s), sous
// verrou (une seule tranche à la fois). Quatre phases :
//   1. moisson     — chaque parcelle : géométrie, sources, quinze rubriques ;
//   2. regroupement — les groupes de l'appelant sont REPRIS tels quels ; une parcelle dont
//                    les rubriques divergent du reste du groupe en SORT, groupe 12 → 12.1,
//                    12.2…, avec une mention qui l'explique ;
//   3. rendu       — une section de rapport par bien + l'ERP du bien (un fichier par bien) ;
//   4. assemblage  — page de garde sobre (société, date), sommaire cliquable avec pastille
//                    jaune si documentation incomplète, sections, liste UNIQUE des bases
//                    interrogées, pagination ; dépôt et adresse valable trente jours.
//
// Hors de ce lot : archivage automatique sur le Drive à J+28 (il faut un accès Google
// côté serveur) et détection des groupes en appli autonome.

import { PDFDocument, PDFName, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { neon } from '@neondatabase/serverless';
import { put, del } from '@vercel/blob';
import { police } from '../lib/polices.mjs';
import { geometrieParcelle, collecterSynthese, qualifier, adressePostale, libelleCommune } from '../lib/moisson.mjs';
import { construireRubriques, composerSection, sources } from './synthese.mjs';

const BUDGET_MS = 40000;
const EXPIRATION_JOURS = 30;
const MAX_PARCELLES = 400;
const PAR_LOT = 3;                    // parcelles moissonnées en parallèle

const sql = () => neon(process.env.DATABASE_URL);
const origine = req => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
const nouvelId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!process.env.DATABASE_URL) return res.status(500).json({ statut: 'echec', cause: 'DATABASE_URL absente du projet RISQUES.' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({ statut: 'echec', cause: 'Stockage de fichiers Vercel non relié au projet RISQUES (BLOB_READ_WRITE_TOKEN absente).' });
  if (!process.env.GEORISQUES_TOKEN) return res.status(500).json({ statut: 'echec', cause: 'GEORISQUES_TOKEN absente.' });
  try {
    if (req.method === 'POST') return await creer(req, res);
    // commande par simple adresse (appli autonome, essais) :
    // ?parcelles=62160-000-XM-0307,62160-000-XM-0308&societe=…&dossier=…
    if (req.query.parcelles) return await creer(req, res, { societe: req.query.societe || null, dossier: req.query.dossier || null,
      appelant: 'adresse', parcelles: String(req.query.parcelles).split(/[,;\s]+/).filter(Boolean) });
    if (req.query.travail) return await interroger(req, res, String(req.query.travail));
    return res.status(400).json({ statut: 'echec', cause: 'POST pour commander un portefeuille, ou GET ?travail=… pour l\'interroger.' });
  } catch (e) {
    return res.status(500).json({ statut: 'echec', cause: e.message, pile: (e.stack || '').split('\n').slice(0, 5) });
  }
}

// ---------------------------------------------------------------------------------------
// COMMANDE
// ---------------------------------------------------------------------------------------
async function creer(req, res, commande = null) {
  // la requête est passée telle quelle (ses en-têtes donnent l'adresse du serveur) ;
  // la commande par adresse arrive à part
  const c = commande || (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
  let groupes = Array.isArray(c.groupes) ? c.groupes : null;
  const autonome = !groupes;
  if (autonome) {
    // appli autonome : RISQUES retrie par commune, section, numéro (16/09/2026)
    const refs = (Array.isArray(c.parcelles) ? c.parcelles : []).map(String).sort(triReference);
    groupes = refs.map((r, i) => ({ numero: String(i + 1), parcelles: [r] }));
  }
  groupes = groupes.map(g => ({ numero: String(g.numero ?? ''), parcelles: (g.parcelles || []).map(x => String(x).trim()).filter(Boolean) }))
                   .filter(g => g.parcelles.length);
  const n = groupes.reduce((s, g) => s + g.parcelles.length, 0);
  if (!n) return res.status(400).json({ statut: 'echec', cause: 'Aucune parcelle dans la commande.' });
  if (n > MAX_PARCELLES) return res.status(400).json({ statut: 'echec', cause: `Plus de ${MAX_PARCELLES} parcelles : scinder la commande.` });

  const id = nouvelId();
  const etat = { phase: 'moisson', autonome, groupes, faites: {}, biens: null, sections: {}, erps: [], horodatage: new Date().toISOString() };
  await sql()`INSERT INTO risques_travail (id, societe, appelant, dossier, etat)
              VALUES (${id}, ${c.societe || null}, ${c.appelant || null}, ${c.dossier || null}, ${JSON.stringify(etat)}::jsonb)`;
  nettoyer().catch(() => {});        // efface au passage quelques travaux expirés
  return res.status(202).json({ statut: 'en_cours', travail: id, interroger: `${origine(req)}/api/portefeuille?travail=${id}`, parcelles: n, biens_annonces: groupes.length });
}

// ---------------------------------------------------------------------------------------
// INTERROGATION : chaque appel fait avancer le travail d'une tranche
// ---------------------------------------------------------------------------------------
async function interroger(req, res, id) {
  const db = sql();
  const [t] = await db`SELECT * FROM risques_travail WHERE id = ${id}`;
  if (!t) return res.status(404).json({ statut: 'echec', cause: 'Travail inconnu.' });
  if (t.statut === 'termine' && t.expire_le && new Date(t.expire_le) < new Date()) {
    await expirer(t);
    return res.status(410).json({ statut: 'expire', cause: `Rapport expiré (${EXPIRATION_JOURS} jours) : le commander à nouveau.` });
  }
  if (t.statut === 'expire') return res.status(410).json({ statut: 'expire' });
  if (t.statut === 'termine') return res.status(200).json(reponseFinale(t));
  if (t.statut === 'echec') return res.status(200).json({ statut: 'echec', cause: t.erreur });

  // verrou : une seule tranche à la fois ; un verrou de plus de 70 s est périmé
  const [pris] = await db`UPDATE risques_travail SET verrou = now()
                          WHERE id = ${id} AND (verrou IS NULL OR verrou < now() - interval '70 seconds') RETURNING id`;
  if (!pris) return res.status(200).json(progression(t.etat, 'tranche en cours, interroger de nouveau'));

  const t0 = Date.now(), etat = t.etat, ctx = { db, t, etat, origine: origine(req), t0 };
  try {
    if (etat.phase === 'moisson') await moissonner(ctx);
    if (etat.phase === 'regroupement') regrouper(etat);
    if (etat.phase === 'rendu') await rendre(ctx);
    if (etat.phase === 'assemblage' && Date.now() - t0 < 15000) {
      const fin = await assembler(ctx);
      await db`UPDATE risques_travail SET statut = 'termine', etat = ${JSON.stringify(etat)}::jsonb, rapport_url = ${fin.url},
               erps = ${JSON.stringify(etat.erps)}::jsonb, fichiers = ${JSON.stringify(fin.fichiers)}::jsonb,
               expire_le = now() + interval '30 days', verrou = NULL, maj_le = now() WHERE id = ${id}`;
      const [f] = await db`SELECT * FROM risques_travail WHERE id = ${id}`;
      return res.status(200).json(reponseFinale(f));
    }
    await db`UPDATE risques_travail SET etat = ${JSON.stringify(etat)}::jsonb, verrou = NULL, maj_le = now() WHERE id = ${id}`;
    return res.status(200).json(progression(etat));
  } catch (e) {
    await db`UPDATE risques_travail SET etat = ${JSON.stringify(etat)}::jsonb, verrou = NULL, erreur = ${e.message}, maj_le = now() WHERE id = ${id}`;
    // une tranche qui échoue se retente au coup suivant (motif retenu le 14/09 contre le rappel)
    return res.status(200).json({ ...progression(etat), avertissement: `tranche interrompue (${e.message}), reprise à la prochaine interrogation` });
  }
}

function progression(etat, message) {
  const total = etat.groupes.reduce((s, g) => s + g.parcelles.length, 0);
  const fait = etat.phase === 'moisson' ? Object.keys(etat.faites).length
             : (etat.biens ? Object.keys(etat.sections).length : 0);
  const sur = etat.phase === 'moisson' ? total : (etat.biens ? etat.biens.length : total);
  const libelles = { moisson: 'Interrogation des bases, parcelle par parcelle', regroupement: 'Regroupement des parcelles',
                     rendu: 'Rédaction du rapport et des états des risques, bien par bien', assemblage: 'Assemblage du rapport de portefeuille' };
  return { statut: 'en_cours', phase: etat.phase, fait, total: sur, message: message || libelles[etat.phase] };
}

function reponseFinale(t) {
  return { statut: 'termine', rapport: t.rapport_url,
           erps: Array.isArray(t.erps) ? t.erps : [],
           expire_le: t.expire_le };
}

// ---------------------------------------------------------------------------------------
// 1. MOISSON
// ---------------------------------------------------------------------------------------
async function moissonner(ctx) {
  const { etat } = ctx;
  const jeton = process.env.GEORISQUES_TOKEN;
  const restantes = etat.groupes.flatMap(g => g.parcelles).filter(r => !etat.faites[r]);
  while (restantes.length && Date.now() - ctx.t0 < BUDGET_MS - 8000) {
    const lot = restantes.splice(0, PAR_LOT);
    await Promise.all(lot.map(async ref => {
      try {
        const bien = await geometrieParcelle(ref);
        if (!bien.obtenu) { etat.faites[ref] = { ref, erreur: bien.cause || 'parcelle introuvable au cadastre' }; return; }
        const [donnees, adresse] = await Promise.all([collecterSynthese(bien, jeton), adressePostale(bien.centre)]);
        const rubriques = construireRubriques(donnees, qualifier(donnees), bien);
        etat.faites[ref] = {
          ref, adresse: adresse ? adresse.libelle : libelleCommune(donnees), commune: libelleCommune(donnees),
          rubriques: rubriques.map(({ carte, ...r }) => ({ ...r, carte: carte ? { service: carte.service, couche: carte.couche, echelle: carte.echelle } : null })),
          signature: rubriques.map(r => r.statut),
          jaune: rubriques.some(r => r.statut === 'non_obtenu'),
          sources: sources(donnees, new Date(etat.horodatage))
        };
      } catch (e) { etat.faites[ref] = { ref, erreur: e.message }; }
    }));
  }
  if (!restantes.length) etat.phase = 'regroupement';
}

// ---------------------------------------------------------------------------------------
// 2. REGROUPEMENT — groupes de l'appelant repris tels quels ; seule la parcelle divergente sort
// ---------------------------------------------------------------------------------------
function regrouper(etat) {
  const biens = [];
  for (const g of etat.groupes) {
    const ok = g.parcelles.map(r => etat.faites[r]).filter(x => x && !x.erreur);
    const ko = g.parcelles.map(r => etat.faites[r]).filter(x => x && x.erreur);
    const sig = x => x.signature.join('|');
    // signature majoritaire (à égalité, celle de la première parcelle dans l'ordre de l'appelant)
    const compte = {};
    ok.forEach(x => { compte[sig(x)] = (compte[sig(x)] || 0) + 1; });
    const majo = ok.length ? Object.keys(compte).sort((a, b) => compte[b] - compte[a] || ok.findIndex(x => sig(x) === a) - ok.findIndex(x => sig(x) === b))[0] : null;
    const principal = ok.filter(x => sig(x) === majo), divergents = ok.filter(x => sig(x) !== majo);
    const eclate = divergents.length > 0 || (ko.length > 0 && ok.length > 0);
    let k = 1;
    const numero = () => eclate ? `${g.numero}.${k++}` : g.numero;
    if (principal.length) biens.push({ numero: numero(), groupe: g.numero, refs: principal.map(x => x.ref), ref: principal[0].ref, mention: null, jaune: principal.some(x => x.jaune) });
    for (const x of divergents) {
      const ecarts = x.rubriques.filter((r, i) => r.statut !== principal[0].signature[i]).map(r => `${r.numero}. ${r.intitule}`);
      biens.push({ numero: numero(), groupe: g.numero, refs: [x.ref], ref: x.ref, jaune: x.jaune,
        mention: `Parcelle relevant du groupe ${g.numero}, isolée de celui-ci en raison d'un élément particulier : ${ecarts.join(' ; ')}.` });
    }
    for (const x of ko) biens.push({ numero: numero(), groupe: g.numero, refs: [x.ref], ref: null, jaune: true, introuvable: x.erreur,
      mention: `Parcelle du groupe ${g.numero} non traitée : ${x.erreur}.` });
  }
  etat.biens = biens;
  etat.phase = 'rendu';
}

// ---------------------------------------------------------------------------------------
// 3. RENDU — une section de rapport et un ERP par bien
// ---------------------------------------------------------------------------------------
async function rendre(ctx) {
  const { etat, t } = ctx;
  for (let i = 0; i < etat.biens.length; i++) {
    if (etat.sections[i]) continue;
    if (Date.now() - ctx.t0 > BUDGET_MS - 14000) return;
    const b = etat.biens[i];
    if (!b.ref) { etat.sections[i] = { vide: true }; continue; }
    const r0 = etat.faites[b.ref];
    const bien = await geometrieParcelle(b.ref);
    const commune = r0.commune || '';
    const identite = {
      titre: `${b.numero ? `Groupe ${b.numero} — ` : ''}${commune}`.trim(),
      court: `${b.numero ? `groupe ${b.numero}` : b.ref}`,
      mention: b.mention,
      lignes: [['Adresse', r0.adresse || '—'], ['Référence(s) cadastrale(s)', b.refs.join(', ')],
               ...(b.refs.length > 1 ? [['Cartes', `centrées sur la parcelle ${b.ref}`]] : []),
               ['Contenance', `${bien.contenance || '—'} m² (parcelle ${b.ref})`]]
    };
    const sec = await composerSection({ ref: b.refs.join(', '), dossier: t.dossier, bien, adresse: { libelle: r0.adresse },
      donnees: {}, rubriques: r0.rubriques, horodatage: new Date(etat.horodatage), avecCartes: true, identite });
    const depot = await put(`risques/portefeuille/${t.id}/section-${String(i + 1).padStart(3, '0')}.pdf`, Buffer.from(sec.octets),
                            { access: 'public', addRandomSuffix: true, contentType: 'application/pdf' });
    etat.sections[i] = { url: depot.url, pages: sec.pages, liens: sec.liens, ancres: sec.ancres };
    // ERP du bien : un fichier par bien (15/09/2026), produit par la fonction ERP elle-même
    try {
      const r = await fetch(`${ctx.origine}/api/erp?parcelle=${encodeURIComponent(b.ref)}${t.dossier ? `&dossier=${encodeURIComponent(t.dossier)}` : ''}`);
      if (r.ok && /pdf/i.test(r.headers.get('content-type') || '')) {
        const e = await put(`risques/portefeuille/${t.id}/ERP_${b.numero || i + 1}_${b.ref}.pdf`, Buffer.from(await r.arrayBuffer()),
                            { access: 'public', addRandomSuffix: true, contentType: 'application/pdf' });
        etat.erps.push({ numero: b.numero || String(i + 1), url: e.url });   // dans l'ordre des biens
      }
    } catch (e) { /* l'ERP manquant se lit dans la réponse finale */ }
  }
  etat.phase = 'assemblage';
}

// ---------------------------------------------------------------------------------------
// 4. ASSEMBLAGE
// ---------------------------------------------------------------------------------------
const NUIT = rgb(0.059, 0.133, 0.220), CANARD = rgb(0.200, 0.514, 0.545), GRIS = rgb(0.396, 0.490, 0.588),
      JAUNE = rgb(1.0, 0.85, 0.30), CARMIN = rgb(0.627, 0.063, 0.251);
const PAGE = { l: 595.28, h: 841.89 }, MG = 56, BAS = 64;

async function assembler(ctx) {
  const { etat, t } = ctx;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const serifG = await doc.embedFont(police('GELASIO_BOLD')), serif = await doc.embedFont(police('GELASIO_REGULAR'));
  const sans = await doc.embedFont(police('SANS_REGULAR')), sansG = await doc.embedFont(police('SANS_BOLD'));
  const date = new Date(etat.horodatage).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  // page de garde UNIQUE et sobre : nom de la société et date (16/09/2026)
  const garde = doc.addPage([PAGE.l, PAGE.h]);
  garde.drawText('RAPPORT DE SYNTHÈSE — RISQUES', { x: MG, y: PAGE.h - 180, size: 22, font: serifG, color: NUIT });
  garde.drawText('Portefeuille immobilier', { x: MG, y: PAGE.h - 208, size: 14, font: serif, color: CANARD });
  garde.drawLine({ start: { x: MG, y: PAGE.h - 224 }, end: { x: PAGE.l - MG, y: PAGE.h - 224 }, thickness: 0.6, color: GRIS });
  garde.drawText(t.societe || 'Société non précisée', { x: MG, y: PAGE.h - 270, size: 18, font: sansG, color: NUIT });
  garde.drawText(`Établi le ${date}`, { x: MG, y: PAGE.h - 296, size: 11, font: sans, color: GRIS });
  garde.drawText(`${etat.biens.length} bien${etat.biens.length > 1 ? 's' : ''}`, { x: MG, y: PAGE.h - 314, size: 11, font: sans, color: GRIS });

  // sommaire : une ligne à plat par bien, numéro de groupe entre parenthèses, pastille
  // JAUNE si documentation incomplète, sinon BLANCHE (16/09 et 24/09/2026)
  const PAR_PAGE = 36, nbSommaire = Math.max(1, Math.ceil(etat.biens.length / PAR_PAGE));
  const pagesSommaire = Array.from({ length: nbSommaire }, () => doc.addPage([PAGE.l, PAGE.h]));
  let debut = 1 + nbSommaire;
  const debutDe = [];
  for (let i = 0; i < etat.biens.length; i++) { debutDe[i] = debut; debut += (etat.sections[i] && etat.sections[i].pages) || 0; }

  // sections
  const toutes = [];
  for (let i = 0; i < etat.biens.length; i++) {
    const s = etat.sections[i];
    if (!s || !s.url) continue;
    const src = await PDFDocument.load(await (await fetch(s.url)).arrayBuffer());
    const copies = await doc.copyPages(src, src.getPageIndices());
    copies.forEach(p => doc.addPage(p));
    toutes.push({ i, pages: copies, s });
  }
  // liens internes de chaque section (carte → annexe), recréés sur les pages copiées
  for (const { pages, s } of toutes) for (const l of s.liens || []) {
    const a = s.ancres && s.ancres[l.numero];
    if (a && pages[l.page] && pages[a.page]) lier(doc, pages[l.page], l.rect, pages[a.page], a.y);
  }
  // sommaire écrit maintenant que les pages sont connues
  const pagesDoc = doc.getPages();
  etat.biens.forEach((b, i) => {
    const p = pagesSommaire[Math.floor(i / PAR_PAGE)], k = i % PAR_PAGE;
    if (k === 0) {
      p.drawText(Math.floor(i / PAR_PAGE) ? 'Sommaire (suite)' : 'Sommaire', { x: MG, y: PAGE.h - 80, size: 16, font: serifG, color: NUIT });
      p.drawText('Pastille jaune : documentation incomplète (une base n\'a pas répondu ou une rubrique n\'est pas renseignée).', { x: MG, y: PAGE.h - 98, size: 8, font: sans, color: GRIS });
    }
    const y = PAGE.h - 124 - k * 18;
    p.drawCircle({ x: MG + 4, y: y + 3, size: 3.6, color: b.jaune ? JAUNE : rgb(1, 1, 1), borderColor: GRIS, borderWidth: 0.6 });
    const texte = `${b.numero ? `(${b.numero}) ` : ''}${b.refs.join(', ')}${etat.faites[b.ref] && etat.faites[b.ref].adresse ? ` — ${etat.faites[b.ref].adresse}` : ''}`;
    p.drawText(couper(texte, sans, 9, PAGE.l - 2 * MG - 60), { x: MG + 14, y, size: 9, font: sans, color: b.introuvable ? CARMIN : NUIT });
    const s = etat.sections[i];
    if (s && s.url) {
      const num = String(debutDe[i] + 1), w = sans.widthOfTextAtSize(num, 9);
      p.drawText(num, { x: PAGE.l - MG - w, y, size: 9, font: sans, color: CANARD });
      lier(doc, p, [MG, y - 4, PAGE.l - MG, y + 11], pagesDoc[debutDe[i]], PAGE.h - 50);
    } else {
      p.drawText('non traité', { x: PAGE.l - MG - sans.widthOfTextAtSize('non traité', 8), y, size: 8, font: sans, color: CARMIN });
    }
  });

  // une seule liste des bases interrogées en fin de rapport global (16/09/2026)
  const src = (Object.values(etat.faites).find(x => x && x.sources) || {}).sources || [];
  let pg = doc.addPage([PAGE.l, PAGE.h]), y = PAGE.h - 80;
  pg.drawText('Bases interrogées', { x: MG, y, size: 14, font: serifG, color: NUIT }); y -= 24;
  for (const [k, v] of src) {
    for (const l of decouper(`${k} — ${v}`, sans, 8.5, PAGE.l - 2 * MG)) {
      if (y < BAS + 20) { pg = doc.addPage([PAGE.l, PAGE.h]); y = PAGE.h - 80; }
      pg.drawText(l, { x: MG, y, size: 8.5, font: sans, color: GRIS }); y -= 12;
    }
    y -= 4;
  }

  // pagination : date d'édition et numéro de page sur chaque page (16/09/2026)
  const tout = doc.getPages(), N = tout.length;
  tout.forEach((p, i) => {
    const d = `Rapport du ${date} — ${i + 1} / ${N}`, w = sans.widthOfTextAtSize(d, 7.5);
    if (i <= nbSommaire) p.drawLine({ start: { x: MG, y: BAS - 18 }, end: { x: PAGE.l - MG, y: BAS - 18 }, thickness: 0.5, color: GRIS });
    if (i <= nbSommaire) p.drawText(couper(t.societe || '', sans, 7.5, PAGE.l - 2 * MG - 170), { x: MG, y: BAS - 32, size: 7.5, font: sans, color: GRIS });
    p.drawText(d, { x: PAGE.l - MG - w, y: BAS - 32, size: 7.5, font: sans, color: GRIS });
  });

  const nom = `ERP_${new Date(etat.horodatage).toISOString().slice(0, 10).replace(/-/g, '')}_${nomFichier(t.societe || 'portefeuille')}.pdf`;
  const depot = await put(`risques/portefeuille/${t.id}/${nom}`, Buffer.from(await doc.save()), { access: 'public', addRandomSuffix: true, contentType: 'application/pdf' });
  const fichiers = [depot.url, ...Object.values(etat.sections).map(s => s && s.url).filter(Boolean), ...etat.erps.map(e => e.url)];
  return { url: depot.url, fichiers };
}

function lier(doc, page, rect, cible, y) {
  const annot = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0],
    Dest: doc.context.obj([cible.ref, 'XYZ', null, y, null]) }));
  let annots = page.node.lookup(PDFName.of('Annots'));
  if (!annots) { annots = doc.context.obj([]); page.node.set(PDFName.of('Annots'), annots); }
  annots.push(annot);
}

// ---------------------------------------------------------------------------------------
// EXPIRATION À TRENTE JOURS
// ---------------------------------------------------------------------------------------
async function expirer(t) {
  try { if (Array.isArray(t.fichiers) && t.fichiers.length) await del(t.fichiers); } catch (e) {}
  await sql()`UPDATE risques_travail SET statut = 'expire', etat = '{}'::jsonb, maj_le = now() WHERE id = ${t.id}`;
}
async function nettoyer() {
  const vieux = await sql()`SELECT * FROM risques_travail WHERE statut = 'termine' AND expire_le < now() LIMIT 5`;
  for (const t of vieux) await expirer(t);
}

// ---------------------------------------------------------------------------------------
// OUTILS
// ---------------------------------------------------------------------------------------
// tri des références « 62160-000-XM-0307 » : commune, préfixe, section, numéro
function triReference(a, b) {
  const p = r => { const m = String(r).match(/^(\d{5})-?(\d{3})-?([0-9A-Z]{1,2})-?(\d{1,4})$/i); return m ? [m[1], m[2], m[3].padStart(2, '0'), m[4].padStart(4, '0')] : [String(r)]; };
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const c = String(x[i] || '').localeCompare(String(y[i] || ''), 'fr'); if (c) return c; }
  return 0;
}
// nom du fichier : espaces et lettres accentuées remplacés par un tiret bas (16/09/2026)
function nomFichier(s) {
  return String(s).trim().replace(/[^A-Za-z0-9-]/g, '_');
}
function decouper(texte, fonte, taille, largeur) {
  const mots = String(texte).split(/\s+/), lignes = []; let l = '';
  for (const m of mots) { const essai = l ? `${l} ${m}` : m; if (fonte.widthOfTextAtSize(essai, taille) > largeur && l) { lignes.push(l); l = m; } else l = essai; }
  if (l) lignes.push(l);
  return lignes;
}
function couper(texte, fonte, taille, largeur) {
  let t = String(texte);
  if (fonte.widthOfTextAtSize(t, taille) <= largeur) return t;
  while (t.length > 1 && fonte.widthOfTextAtSize(t + '…', taille) > largeur) t = t.slice(0, -1);
  return t + '…';
}
