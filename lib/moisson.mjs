// RISQUES — /lib/moisson.mjs
//
// Bibliotheque commune aux deux documents produits par RISQUES :
//   - l'etat des risques (/api/erp.mjs), document reglementaire ferme ;
//   - le rapport de synthese exhaustif (/api/synthese.mjs), document de
//     conseil a seize rubriques.
//
// Elle regroupe ce que les deux ont en commun et qui ne doit exister qu'en
// UN SEUL endroit : la geometrie parcellaire, les appels aux bases, la
// qualification aux seuils de R.125-23, et les outils cartographiques.
// Une regle de seuil ecrite deux fois derive ; la mettre ici la fige.
//
// DEUX NIVEAUX DE COLLECTE
//   collecter(bien, jeton)          : la moisson de l'ERP, inchangee.
//   collecterSynthese(bien, jeton)  : la meme, elargie aux rubriques que
//                                     l'ERP ne restitue pas (SIS, PEB,
//                                     remontee de nappe, canalisations,
//                                     trait de cote, PPR prescrits).
//
// SOURCES NON REPONDANTES
// Chaque bloc de donnees porte `ok` (la source a repondu) et, pour les
// rubriques de la synthese, `obtenu`. Une source muette ne bloque jamais la
// generation : la rubrique paraît « non obtenue », en jaune, a sa place.
//
// CATALOGUE DES SOURCES DE LA SYNTHESE
// Les points d'entree Georisques v2 sont valides pour les rubriques de
// l'ERP. Pour les rubriques ajoutees, le catalogue ci-dessous liste des
// CANDIDATS interroges dans l'ordre ; le premier qui repond l'emporte, et le
// rapport indique lequel. Un candidat faux ne casse rien : il est note
// « non obtenu ». Le mode ?debug=1 de /api/synthese restitue, rubrique par
// rubrique, quel candidat a repondu — c'est l'outil de mise au point.

import { lirePng } from './png.mjs';
export const GEO = 'https://www.georisques.gouv.fr';
export const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
export const WMS_IGN = 'https://data.geopf.fr/wms-r';
export const WMS_RISQUES = 'https://mapsref.brgm.fr/wxs/georisques/risques';
export const BAN = 'https://api-adresse.data.gouv.fr';

// ===========================================================================
// GEOMETRIE
// ===========================================================================
export async function geometrieParcelle(reference) {
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

export function extraireAnneaux(geom) {
  const out = [];
  const parcourir = (x) => {
    if (!Array.isArray(x) || typeof x[0] === 'number') return;
    if (Array.isArray(x[0]) && typeof x[0][0] === 'number') { out.push(x); return; }
    x.forEach(parcourir);
  };
  if (geom) parcourir(geom.coordinates);
  return out;
}

export function margeAdaptee(contenance) {
  if (!contenance) return 250;
  return Math.max(60, Math.min(1200, Math.round(Math.sqrt(contenance) * 2.5)));
}

export function emprise(centre, marge, px) {
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

export function getMap(service, couche, bbox, px, transparent) {
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

// GetFeatureInfo au centre de l'emprise : les attributs de la couche sous le
// bien. Sert aux rubriques dont la donnee n'est publiee qu'en flux
// cartographique (remontee de nappe, canalisations). Retourne null si la
// couche ne repond pas ou ne porte rien a cet endroit.
export async function interrogerCouche(service, couche, centre) {
  // 13/10/2026 (sonde ?etape=info) : le serveur du BRGM refuse INFO_FORMAT
  // application/json (« Unsupported INFO_FORMAT ») ; il rend du GML MapServer
  // (<msGMLOutput><COUCHE_layer><COUCHE_feature><attribut>valeur</attribut>…).
  const px = { l: 101, h: 101 };
  const bbox = emprise(centre, 25, px);
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetFeatureInfo',
    LAYERS: couche, QUERY_LAYERS: couche, STYLES: '', CRS: 'EPSG:4326',
    BBOX: `${bbox.latMin},${bbox.lonMin},${bbox.latMax},${bbox.lonMax}`,
    WIDTH: '101', HEIGHT: '101', I: '50', J: '50',
    INFO_FORMAT: 'application/vnd.ogc.gml', FEATURE_COUNT: '5'
  });
  try {
    const r = await fetch(`${service}?${p}`);
    const type = r.headers.get('content-type') || '';
    const t = await r.text();
    if (r.status !== 200 || !/gml|xml/i.test(type) || !/msGMLOutput/.test(t)) return { ok: false, code: r.status, items: [] };
    const items = [...t.matchAll(/<(\w+)_feature>([\s\S]*?)<\/\1_feature>/g)].map(m => {
      const o = {};
      for (const a of m[2].replace(/<gml:boundedBy>[\s\S]*?<\/gml:boundedBy>/g, '').replace(/<[\w]+:[\w]+[^>]*>[\s\S]*?<\/[\w]+:[\w]+>/g, '')
                             .matchAll(/<(\w+)>([^<]*)<\/\1>/g)) o[a[1]] = a[2].trim();
      return o;
    });
    return { ok: true, items };
  } catch (e) {
    return { ok: false, erreur: e.message, items: [] };
  }
}

// Distance en mètres entre le contour de la parcelle et une géométrie GeoJSON
// quelconque (point, ligne, polygone) : plus courte distance sommet ↔ segment,
// en projection locale. 0 si les deux se touchent.
export function distanceContours(parcelle, geom) {
  const lignes = g => !g ? [] : g.type === 'Point' ? [[g.coordinates]] : g.type === 'MultiPoint' ? g.coordinates.map(c => [c])
    : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates
    : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
  const A = lignes(parcelle), B = lignes(geom);
  if (!A.length || !B.length) return null;
  if ((geom.type === 'Polygon' || geom.type === 'MultiPolygon') && contoursSeTouchent(parcelle, geom)) return 0;
  const lat0 = A[0][0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110540;
  const pr = ([x, y]) => [x * kx, y * ky];
  const dSeg = (p, a, b) => { const [px, py] = pr(p), [ax, ay] = pr(a), [bx, by] = pr(b);
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy); };
  const segs = L => L.flatMap(l => l.length === 1 ? [[l[0], l[0]]] : l.slice(1).map((pt, i) => [l[i], pt]));
  const sa = segs(A), sb = segs(B);
  // deux côtés qui se croisent : distance nulle
  const cote = (a, b, c) => (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
  for (const [p1, p2] of sa) for (const [p3, p4] of sb) {
    if (((cote(p3, p4, p1) > 0) !== (cote(p3, p4, p2) > 0)) && ((cote(p1, p2, p3) > 0) !== (cote(p1, p2, p4) > 0))) return 0;
  }
  let m = Infinity;
  for (const l of A) for (const p of l) for (const [a, b] of sb) m = Math.min(m, dSeg(p, a, b));
  for (const l of B) for (const p of l) for (const [a, b] of sa) m = Math.min(m, dSeg(p, a, b));
  return Math.round(m);
}

// Tracés de canalisations AUTOUR du bien (13/10/2026, sonde ?etape=wfs) : le flux
// WFS du BRGM sert les trois types de tracés en GeoJSON ; « CANALISATIONS » n'y
// est qu'un groupe de la carte. Rayon de lecture : environ un kilomètre.
export const RAYON_CANALISATIONS_M = 1000;
export async function canalisationsAutour(bien) {
  const { lon, lat } = bien.centre, dLat = RAYON_CANALISATIONS_M / 110540, dLon = RAYON_CANALISATIONS_M / (111320 * Math.cos(lat * Math.PI / 180));
  const types = ['C_GAZ', 'C_HYDROCARBURES', 'C_PRODUITS_CHIM'];
  const vus = new Set(), items = [];
  let repondu = 0;
  for (const t of types) {
    const p = new URLSearchParams({ SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: t, COUNT: '200',
      SRSNAME: 'EPSG:4326', BBOX: `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon},urn:ogc:def:crs:EPSG::4326`, OUTPUTFORMAT: 'geojson' });
    try {
      const r = await fetch(`${WMS_RISQUES}?${p}`);
      if (r.status !== 200) continue;
      const j = await r.json();
      repondu++;
      for (const f of j.features || []) {
        const cle = JSON.stringify(f.properties) + JSON.stringify(f.bbox || '');
        if (vus.has(cle)) continue;
        vus.add(cle);
        items.push({ ...f.properties, distance: distanceContours(bien.geometrie, f.geometry) });
      }
    } catch (e) { /* type suivant */ }
  }
  items.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
  return repondu ? { obtenu: true, items, source: { libelle: `flux WFS BRGM (gaz, hydrocarbures, produits chimiques), rayon ${RAYON_CANALISATIONS_M} m` } }
                 : { obtenu: false, items: [], source: { libelle: 'flux WFS BRGM (canalisations)' } };
}

// REMONTÉE DE NAPPE (13/10/2026, étalonnage par la sonde) : la couche REMNAPPE du
// BRGM n'est que DESSINÉE (aucun attribut lisible sous un point) et ne s'affiche
// qu'entre le 1/90 000 et le 1/500 000. On demande donc une image d'environ
// 4,3 km de côté sur 101 pixels (≈ 1/150 000, un pixel ≈ 43 m) centrée sur le
// bien, et on lit la couleur sous le centre, reconnue d'après la LÉGENDE
// OFFICIELLE (GetStyles) :
//   #e31a1c rouge  — classe 1, zones potentiellement sujettes aux débordements de nappe
//   #ff7f00 orange — classe 2, zones potentiellement sujettes aux inondations de cave
//   #ffffff blanc  — classe 0, pas de débordement de nappe ni d'inondation de cave
// Le vote se fait sur les 3 × 3 pixels du centre (les bordures adoucies sont
// ignorées) ; une image transparente sous le bien = hors couverture : on ne
// conclut pas. Témoins : Abbeville (vallée de la Somme) et Boulogne (Liane) en rouge.
export const LEGENDE_NAPPE = [
  { classe: '1', couleur: [0xe3, 0x1a, 0x1c], niveau: 'débordement de nappe', libelle: 'Zones potentiellement sujettes aux débordements de nappe' },
  { classe: '2', couleur: [0xff, 0x7f, 0x00], niveau: 'inondation de cave', libelle: 'Zones potentiellement sujettes aux inondations de cave' },
  { classe: '0', couleur: [0xff, 0xff, 0xff], niveau: 'aucun', libelle: "Pas de débordement de nappe ni d'inondation de cave" }
];
export async function nappeParCouleur(bien) {
  const libelle = 'flux BRGM REMNAPPE, lecture de la couleur de la carte nationale (≈ 1/150 000) sous le bien, légende officielle';
  const { lon, lat } = bien.centre, mx = 2150, dLat = mx / 110540, dLon = mx / (111320 * Math.cos(lat * Math.PI / 180));
  const p = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: 'REMNAPPE', STYLES: '', CRS: 'EPSG:4326',
    BBOX: `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`, WIDTH: '101', HEIGHT: '101', FORMAT: 'image/png', TRANSPARENT: 'TRUE' });
  try {
    const r = await fetch(`${WMS_RISQUES}?${p}`);
    if (r.status !== 200 || !/png/i.test(r.headers.get('content-type') || '')) return { obtenu: false, items: [], source: { libelle } };
    const img = lirePng(Buffer.from(await r.arrayBuffer()));
    const votes = {};
    for (let y = 49; y <= 51; y++) for (let x = 49; x <= 51; x++) {
      const c = img.pixel(x, y);
      if (c[3] < 128) { votes.transparent = (votes.transparent || 0) + 1; continue; }
      let mieux = null, dmin = Infinity;
      for (const l of LEGENDE_NAPPE) { const d = Math.hypot(c[0] - l.couleur[0], c[1] - l.couleur[1], c[2] - l.couleur[2]); if (d < dmin) { dmin = d; mieux = l; } }
      if (dmin <= 60) votes[mieux.classe] = (votes[mieux.classe] || 0) + 1;
    }
    const [gagnant, n] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    if (!gagnant || gagnant === 'transparent' || n < 5) return { obtenu: false, items: [], source: { libelle, motif: 'bien hors de la couverture de la carte, ou couleur illisible' } };
    const l = LEGENDE_NAPPE.find(x => x.classe === gagnant);
    return { obtenu: true, items: [{ classe: l.classe, niveau: l.niveau, libelle: l.libelle }], source: { libelle } };
  } catch (e) {
    return { obtenu: false, items: [], source: { libelle, motif: e.message } };
  }
}

// BASOL (sites pollués appelant une action des pouvoirs publics), deuxième
// bloc des sols pollués (26/09/2026) : interrogé à la commune, distance au bien.
export async function basolDeLaCommune(ctx) {
  const r = await v2('/api/v2/ssp/instructions', { codesInsee: ctx.insee }, ctx.jeton);
  if (!r.ok) return { obtenu: false, items: [], source: { libelle: 'Géorisques v2 SSP instructions (BASOL)' } };
  const items = r.items.map(x => ({ ...x, distance: x.geom ? distanceContours(ctx.bien.geometrie, x.geom) : null }))
    .sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
  return { obtenu: true, items, source: { libelle: 'Géorisques v2 SSP instructions (BASOL), commune' } };
}

// Le contour d'un secteur (GeoJSON, lon/lat) touche-t-il le contour de la parcelle ?
// Test simple et sûr : un sommet de l'un dans l'autre, ou deux côtés qui se croisent.
export function contoursSeTouchent(g1, g2) {
  const anneaux = g => !g ? [] : g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
  const dans = (pt, a) => { let c = false; for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [xi, yi] = a[i], [xj, yj] = a[j];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) c = !c; } return c; };
  const croise = (p1, p2, p3, p4) => { const d = (a, b, c) => (c[0] - a[0]) * (b[1] - a[1]) - (b[0] - a[0]) * (c[1] - a[1]);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)); };
  for (const a of anneaux(g1)) for (const b of anneaux(g2)) {
    if (a.some(pt => dans(pt, b)) || b.some(pt => dans(pt, a))) return true;
    for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) if (croise(a[i], a[i + 1], b[j], b[j + 1])) return true;
  }
  return false;
}

export async function image(url) {
  const r = await fetch(url);
  const type = r.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return null;
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 200) return null;   // PNG transparent vide
  return new Uint8Array(buf);
}

export function projeter([lon, lat], bbox, largeur, hauteur) {
  return {
    x: (lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin) * largeur,
    y: (lat - bbox.latMin) / (bbox.latMax - bbox.latMin) * hauteur
  };
}

export function distance(centre, geom) {
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

export function libelleCommune(d) {
  const c = d.commune.items[0];
  if (!c) return '—';
  return `${c.name || '—'} (${c.insee || '—'})`;
}

// Adresse postale par geocodage inverse (Base adresse nationale). Le rapport
// de synthese porte l'adresse en page de garde ; l'ERP n'en a pas besoin.
export async function adressePostale(centre) {
  try {
    const r = await fetch(`${BAN}/reverse/?lon=${centre.lon}&lat=${centre.lat}&type=housenumber`,
                          { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return null;
    const j = await r.json();
    const f = (j.features || [])[0];
    if (!f) return null;
    return { libelle: f.properties.label, distance: Math.round(f.properties.distance || 0) };
  } catch {
    return null;
  }
}

// ===========================================================================
// APPELS AUX BASES
// ===========================================================================
export async function appelJson(chemin, jeton) {
  try {
    const r = await fetch(`${GEO}${chemin}`, {
      headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/json' }
    });
    if (r.status !== 200) return { ok: false, code: r.status };
    return { ok: true, json: await r.json() };
  } catch (e) {
    return { ok: false, erreur: e.message };
  }
}

export async function v2(chemin, criteres, jeton) {
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

export async function v1(chemin, criteres) {
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

export async function gpu(couche, geometrie) {
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

// Premier candidat qui repond. Chaque candidat : { type: 'v2'|'v1'|'gpu'|'wms',
// chemin|couche, criteres }. Le resultat porte `source` (le candidat retenu)
// et `obtenu` (au moins un candidat a repondu 200).
export async function premierQuiRepond(candidats, ctx) {
  const tentatives = [];
  for (const c of candidats) {
    let r;
    if (c.type === 'v2')       r = await v2(c.chemin, c.criteres(ctx), ctx.jeton);
    else if (c.type === 'v1')  r = await v1(c.chemin, c.criteres(ctx));
    else if (c.type === 'gpu') r = await gpu(c.couche, ctx.bien.geometrie);
    else if (c.type === 'wms') r = await interrogerCouche(c.service, c.couche, ctx.bien.centre);
    else continue;
    tentatives.push({ candidat: c.libelle || c.chemin || c.couche, ok: r.ok, code: r.code || null });
    if (r.ok) return { ...r, obtenu: true, source: c, tentatives };
  }
  return { ok: false, obtenu: false, items: [], source: null, tentatives };
}

// ---------------------------------------------------------------------------
// Pieces documentaires d'un plan de prevention (ERP).
// ---------------------------------------------------------------------------
export async function piecesDuPlan(famille, idGaspar, jeton) {
  const r = await appelJson(`/api/v2/gaspar/${famille}/${idGaspar}`, jeton);
  if (!r.ok || !Array.isArray(r.json.documents)) return { reglement: null, zonages: [], toutes: [] };

  const toutes = r.json.documents.map(x => ({
    type: (x.type || '').trim(),
    titre: x.titre || null,
    uuid: x.uuidDocument || null
  }));

  return {
    aleas: ((r.json.communes || [])[0] || {}).aleas || [],
    lien: ((r.json.communes || [])[0] || {}).lienPpr || null,
    reglement: toutes.find(x => x.type === 'Règlement du PPR') || null,
    zonages: toutes.filter(x => x.type === 'Plan de zonages réglementaires'),
    toutes
  };
}

export async function pagesDePiece(famille, idGaspar, uuid, jeton, limite) {
  const url = `${GEO}/api/v2/gaspar/${famille}/${idGaspar}/documents/${uuid}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${jeton}`, Accept: 'application/pdf' }
  });
  if (r.status !== 200) throw new Error(`pièce indisponible (HTTP ${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length < 5 || buf[0] !== 0x25 || buf[1] !== 0x50) {
    throw new Error('la pièce reçue n\'est pas un PDF');
  }
  if (buf.length > limite) {
    throw new Error(`pièce trop volumineuse (${Math.round(buf.length / 1048576)} Mo)`);
  }
  return buf;
}

// ===========================================================================
// COLLECTE — ERP (inchangee)
// ===========================================================================
export async function collecter(bien, jeton) {
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

// ===========================================================================
// COLLECTE — SYNTHESE (ERP + rubriques complementaires)
// ===========================================================================
// Catalogue des sources complementaires. Voir la note en tete de fichier :
// ce sont des candidats, le mode debug dit lequel a repondu.
export const CATALOGUE = {
  // 13/10/2026 : chemins relevés dans la documentation publiée par Géorisques
  // (api-docs v2 et v1) et vérifiés sur un témoin (Lille : 28 secteurs, TRI
  // Lille). L'interrogation se fait À LA COMMUNE ; RISQUES teste ensuite
  // lui-même si le contour d'un secteur touche celui de la parcelle.
  sis: [
    { type: 'v2', libelle: 'Géorisques v2 SIS (conclusions, commune)', chemin: '/api/v2/ssp/conclusions_sis',
      criteres: c => ({ codesInsee: c.insee }), echelle: 'commune' },
    { type: 'v1', libelle: 'Géorisques v1 SIS (conclusions, commune)', chemin: '/api/v1/ssp/conclusions_sis',
      criteres: c => ({ code_insee: c.insee }), echelle: 'commune' }
  ],
  // Remontée de nappe et canalisations : absentes de l'interface Géorisques ;
  // seul le flux du BRGM les porte (attributs sous le bien, en GML).
  nappe: [
    { type: 'wms', libelle: 'flux BRGM REMNAPPE_FR (attributs sous le bien)', service: WMS_RISQUES, couche: 'REMNAPPE_FR' }
  ],
  // canalisations : lues autour du bien par canalisationsAutour() (WFS), plus par ce catalogue
  canalisations: [],
  // Le TRI vaut pour toute la commune (arbitrage du 26/09/2026 : simple ligne
  // dans la rubrique inondation).
  tri: [
    { type: 'v2', libelle: 'Géorisques v2 TRI (GASPAR, commune)', chemin: '/api/v2/gaspar/tri',
      criteres: c => ({ codesInsee: c.insee }), echelle: 'commune' },
    { type: 'v1', libelle: 'Géorisques v1 TRI (GASPAR, commune)', chemin: '/api/v1/gaspar/tri',
      criteres: c => ({ code_insee: c.insee }), echelle: 'commune' }
  ]
};

// Couches WMS utilisees pour les cartes de la synthese. Une couche absente
// du service ne provoque pas d'erreur : la carte paraît sur fond de plan
// seul et la legende le dit (« couche non obtenue »), jamais « rien ».
export const COUCHES_SYNTHESE = {
  pprt:          { service: WMS_RISQUES, couche: 'PPRT_ZONE_RISQIND' },
  pprn:          { service: WMS_RISQUES, couche: 'PPRN_ZONE_INOND' },
  pprn_mvt:      { service: WMS_RISQUES, couche: 'PPRN_ZONE_MVT' },
  pprm:          { service: WMS_RISQUES, couche: 'PPRM_ZONE_MINIER' },
  prescrits:     { service: WMS_RISQUES, couche: 'PPRN_PERIMETRE_INOND' },
  // noms vérifiés le 13/10/2026 dans le GetCapabilities du BRGM (298 couches)
  sismique:      { service: WMS_RISQUES, couche: 'risq_zonage_sismique' },
  radon:         { service: WMS_RISQUES, couche: 'RADON_COMMUNE' },
  trait_cote:    { service: WMS_RISQUES, couche: 'PPRN_ZONE_SUBMAR' },
  old:           { service: WMS_IGN,     couche: 'DEBROUSSAILLEMENT' },
  sis:           { service: WMS_RISQUES, couche: 'SSP_CLASSIFICATION_SIS' },
  icpe:          { service: WMS_RISQUES, couche: 'INSTALLATIONS_CLASSEES_SIMPLIFIE' },
  casias:        { service: WMS_RISQUES, couche: 'SSP_ETABLISSEMENT' },   // nom vérifié le 13/10/2026
  basol:         { service: WMS_RISQUES, couche: 'SSP_INSTRUCTION' },
  peb:           { service: null,        couche: null },   // pas de flux national
  rga:           { service: WMS_RISQUES, couche: 'ALEARG' },
  nappe:         { service: WMS_RISQUES, couche: 'REMNAPPE_FR' },
  canalisations: { service: WMS_RISQUES, couche: 'CANALISATIONS' },
  catnat:        { service: WMS_RISQUES, couche: 'TRI_COMMUNE' }
};

export async function collecterSynthese(bien, jeton) {
  const ctx = { bien, jeton, insee: bien.reference.split('-')[0] };

  // La moisson de l'ERP d'une part, les collectes complementaires d'autre
  // part : toutes independantes, donc lancees ensemble. Sept appels de plus
  // que l'ERP, sans allonger le temps de reponse d'autant.
  const [d, sis, nappe, canalisations, tri, zertc, infoSurf, supS, basol] = await Promise.all([
    collecter(bien, jeton),
    // Pollution des sols : secteurs d'information sur les sols (L.125-6)
    premierQuiRepond(CATALOGUE.sis, ctx),
    // Informations complementaires hors IAL
    nappeParCouleur(bien),
    canalisationsAutour(bien),
    // Directive inondation : TRI et scenarios, pour l'alea de reference
    premierQuiRepond(CATALOGUE.tri, ctx),
    // Recul du trait de cote — cascade tranchee le 11/09/2026 :
    //   1) ZERTC integrees au document d'urbanisme (CNIG 54-01 / 54-02)
    //   2) a defaut, carte de prefiguration (pre-ZERTC)
    //   3) a defaut, PPR littoral comportant ce risque
    gpu('prescription-surf', bien.geometrie),
    gpu('info-surf', bien.geometrie),
    // Plan d'exposition au bruit : servitude annexee au document
    // d'urbanisme. Le GPU ne l'expose pas sous un nom propre ; on cherche
    // « bruit » ou « PEB » dans les informations surfaciques et les
    // assiettes de servitudes.
    gpu('assiette-sup-s', bien.geometrie),
    basolDeLaCommune(ctx)
  ]);

  // SIS : interrogés à la commune, puis rapprochés du contour de la parcelle
  sis.dansBien = sis.obtenu ? sis.items.filter(x => contoursSeTouchent(x.geom, bien.geometrie)) : [];
  Object.assign(d, { sis, nappe, canalisations, tri, zertc, infoSurf, supS, basol });
  return d;
}

// ===========================================================================
// QUALIFICATION — seuils de R.125-23 (ERP, inchangee)
// ===========================================================================
export function qualifier(d) {
  const corps = [], ecartes = [], alertes = [];

  // 5° sismicite : obligation des la zone 2
  const s = d.sismique.items[0];
  if (s) {
    const z = parseInt(s.typeZone, 10);
    if (z >= 2) corps.push({
      cle: 'sismique', article: '5°', intitule: 'Sismicité',
      valeur: s.zoneSismicite,
      precision: "Une fiche d'information sur le risque sismique doit être annexée (R. 125-24, 2°) : voir la liste des pièces à joindre."
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
      precision: "Une fiche d'information sur les obligations de débroussaillement doit être annexée : voir la liste des pièces à joindre."
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
// OUTILS DE LECTURE PARTAGES
// ===========================================================================
// Un PPR est « approuve » ou « prescrit » selon son etat de procedure. Le 4°
// de R.125-23 vise les perimetres seulement prescrits : on ne filtre jamais
// silencieusement sur « approuve ».
export function etatPlan(e) {
  const t = String(e.libelleEtatProcedure || e.etatProcedure || e.codeEtatProcedure || '').toLowerCase();
  if (/approuv|opposable|anticip/.test(t)) return 'approuve';
  if (/prescri|etude|étude|elabor|élabor/.test(t)) return 'prescrit';
  return 'indetermine';
}

// Convertit jj/mm/aaaa en nombre aaaammjj, comparable.
export function cleDate(date) {
  if (!date) return 0;
  const m = String(date).split('/');
  if (m.length !== 3) return 0;
  return Number(m[2]) * 10000 + Number(m[1]) * 100 + Number(m[0]);
}

// Les etablissements de regime « Non ICPE » sont ecartes, comme dans l'ERP.
export function icpeRetenues(items) {
  return items.filter(x => {
    const r = (x.regime || '').toLowerCase();
    return r && !r.includes('non icpe');
  });
}
