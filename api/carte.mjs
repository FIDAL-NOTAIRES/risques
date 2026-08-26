// RISQUES — /api/carte.mjs
//
// Cartographie du bien, UNE CARTE PAR SUJET, a la maniere de l'ERRIAL.
// Superposer le zonage inondation et le zonage sismique sur une meme image
// n'aurait aucun sens : chaque rubrique a sa carte.
//
// NOMS DE COUCHES
// Etablis par GetCapabilities des deux services : 501 couches cote
// Geoplateforme IGN, 301 cote Georisques. La convention Georisques est
// systematique : chaque alea se decline en zonage reglementaire (_ZONE_),
// perimetre (_PERIMETRE_) et zone d'alea. Pour un etat des risques, c'est le
// ZONAGE REGLEMENTAIRE qui compte : c'est lui qui fonde l'obligation au titre
// de R.125-23.
//
// SONDAGE AUTOMATIQUE
// Un nom de couche errone ne provoque pas d'erreur : le service renvoie une
// exception XML a la place de l'image, et la carte parait simplement vide.
// C'est le pire des cas pour un outil notarial — une absence apparente qui
// n'en est pas une. Le mode sondage interroge donc chaque couche et verifie le
// type de contenu retourne. Une couche non confirmee n'est jamais presentee
// comme vide : elle est presentee comme non verifiee.
//
// Usage :
//   /api/carte?parcelle=62160-000-XM-0307        toutes les cartes
//   /api/carte?parcelle=...&sujet=inondation     une seule
//   /api/carte?parcelle=...&mode=sondage         verifie les couches
//   /api/carte?mode=capabilities                 inventaire complet
//   /api/carte?parcelle=...&json=1               les URL, pour le PDF

const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const WMS_IGN = 'https://data.geopf.fr/wms-r';
const WMS_RISQUES = 'https://mapsref.brgm.fr/wxs/georisques/risques';

const FONDS = {
  plan:  'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2',
  ortho: 'HR.ORTHOIMAGERY.ORTHOPHOTOS',
  scan:  'GEOGRAPHICALGRIDSYSTEMS.MAPS'
};

// ---------------------------------------------------------------------------
// Sujets cartographiques. `ial` renvoie a l'item de R.125-23 lorsque la
// rubrique releve du corps de l'etat des risques.
// ---------------------------------------------------------------------------
const SUJETS = {
  inondation:    { titre: 'Inondation — zonage réglementaire',        service: WMS_RISQUES, couche: 'PPRN_ZONE_INOND',    ial: '2°' },
  submersion:    { titre: 'Submersion marine — zonage réglementaire', service: WMS_RISQUES, couche: 'PPRN_ZONE_SUBMAR',   ial: '2°' },
  mouvement:     { titre: 'Mouvement de terrain — zonage',            service: WMS_RISQUES, couche: 'PPRN_ZONE_MVT',      ial: '2°' },
  seisme_ppr:    { titre: 'Séisme — zonage d\'un PPR',                service: WMS_RISQUES, couche: 'PPRN_ZONE_SEISME',   ial: '2°' },
  avalanche:     { titre: 'Avalanche — zonage réglementaire',         service: WMS_RISQUES, couche: 'PPRN_ZONE_AVALANCHE', ial: '2°' },
  feu:           { titre: 'Feu de forêt — zonage réglementaire',      service: WMS_RISQUES, couche: 'PPRN_ZONE_FEU',      ial: '2°' },
  // PPRM : la convention ne comporte que trois couches, verifiees par
  // GetCapabilities — PPRM_MINIER, PPRM_PERIMETRE_MINIER, PPRM_ZONE_MINIER.
  // Le zonage reglementaire est PPRM_ZONE_MINIER. PPRM_RISQINOND, retenu par
  // analogie dans une version precedente, N'EXISTE PAS : le sondage renvoyait
  // une exception XML, donc une carte d'apparence vide.
  minier:        { titre: 'Risque minier — zonage réglementaire',      service: WMS_RISQUES, couche: 'PPRM_ZONE_MINIER',  ial: '3°' },
  technologique: { titre: 'Risque industriel — zonage PPRT',          service: WMS_RISQUES, couche: 'PPRT_ZONE_RISQIND',  ial: '1°' },
  icpe:          { titre: 'Installations classées',                   service: WMS_RISQUES, couche: 'INSTALLATIONS_CLASSEES_SIMPLIFIE' },
  mvt_emprises:  { titre: 'Mouvements de terrain recensés',           service: WMS_RISQUES, couche: 'MVT_EMPRISES' },
  // TRI : convention entierement differente, etablie par GetCapabilities.
  // TRI_ZONE_INOND n'existe pas. La cartographie suit la directive Inondation :
  // trois scenarios de probabilite, chacun decline en classes d'alea.
  //   LIMITETRI_{scenario}_{alea}  ->  01 a 03 pour le scenario
  //                                    01FOR fort, 02MOY moyen, 04FAI faible
  // Le scenario 02 en alea moyen est l'alea de reference : c'est celui qui
  // fonde le zonage reglementaire, donc le seul pertinent pour un etat des
  // risques. Les autres restent accessibles par ?sujet= pour le rapport
  // de synthese.
  tri_commune:   { titre: 'Territoire à risque important d\'inondation', service: WMS_RISQUES, couche: 'TRI_COMMUNE' },
  tri_reference: { titre: 'TRI — aléa de référence (scénario moyen)',   service: WMS_RISQUES, couche: 'LIMITETRI_02_02MOY' },
  tri_fort:      { titre: 'TRI — aléa fort (crue fréquente)',           service: WMS_RISQUES, couche: 'LIMITETRI_01_01FOR' },
  tri_faible:    { titre: 'TRI — aléa faible (crue exceptionnelle)',    service: WMS_RISQUES, couche: 'LIMITETRI_03_04FAI' },
  debroussail:   { titre: 'Obligations de débroussaillement',         service: WMS_IGN,     couche: 'DEBROUSSAILLEMENT',  ial: '8°' },
  parcellaire:   { titre: 'Parcellaire cadastral voisin',             service: WMS_IGN,     couche: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS' }
};

const TAILLE = { largeur: 560, hauteur: 400 };

export default async function handler(req, res) {
  const mode = req.query.mode ? req.query.mode.toString() : 'carte';
  if (mode === 'capabilities') return capabilites(res);

  const cible = await centrer(req);
  if (!cible.obtenu) return res.status(200).json({ resultat: 'ECHEC', cause: cible.cause });

  // Marge adaptative : une parcelle de centre-ville serait illisible a 500 m,
  // une grande emprise rurale serait coupee a 100 m. On part de la contenance.
  const marge = req.query.marge
    ? Math.max(40, Math.min(5000, parseInt(req.query.marge, 10)))
    : margeAdaptee(cible.contenance);

  const bbox = emprise(cible.centre, marge, TAILLE);
  const fond = FONDS[req.query.fond] || FONDS.plan;
  const urlFond = getMap(WMS_IGN, fond, bbox, false);

  const demande = req.query.sujet ? req.query.sujet.toString() : null;
  if (demande && !SUJETS[demande]) {
    return res.status(400).json({
      resultat: 'ECHEC', cause: `Sujet inconnu : ${demande}`,
      sujets: Object.keys(SUJETS)
    });
  }
  const noms = demande ? [demande] : Object.keys(SUJETS);

  if (mode === 'sondage') {
    const sondes = {};
    for (const n of noms) {
      sondes[n] = await sonder(SUJETS[n], bbox);
      await pause(120);
    }
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      objet: 'Verification des couches WMS sur l\'emprise du bien',
      methode: "Une couche erronee renvoie une exception XML au lieu d'une image : la carte parait vide alors qu'elle est fausse. Le sondage lit le type de contenu retourne.",
      cible: { libelle: cible.libelle, centre: cible.centre, marge_metres: marge },
      confirmees: Object.entries(sondes).filter(([, s]) => s.image).map(([n]) => n),
      a_verifier: Object.entries(sondes).filter(([, s]) => !s.image).map(([n, s]) => ({ sujet: n, couche: SUJETS[n].couche, cause: s.cause })),
      detail: sondes
    });
  }

  const cartes = noms.map(n => ({
    cle: n,
    titre: SUJETS[n].titre,
    ial: SUJETS[n].ial || null,
    couche: SUJETS[n].couche,
    url: getMap(SUJETS[n].service, SUJETS[n].couche, bbox, true)
  }));

  if (req.query.json === '1') {
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      cible: { libelle: cible.libelle, centre: cible.centre,
               contenance_m2: cible.contenance, marge_metres: marge },
      bbox, taille: TAILLE,
      fond_de_plan: urlFond,
      cartes,
      contour_parcelle: cible.anneaux || null,
      note: "URL directement embarquables dans le PDF. Sonder les couches avant emploi : ?mode=sondage."
    });
  }

  return page(res, { cible, bbox, urlFond, cartes, marge, fond: req.query.fond || 'plan' });
}

// ---------------------------------------------------------------------------
async function sonder(sujet, bbox) {
  const url = getMap(sujet.service, sujet.couche, bbox, true);
  try {
    const r = await fetch(url);
    const type = r.headers.get('content-type') || '';
    const buf = await r.arrayBuffer();
    if (type.startsWith('image/')) {
      return { image: true, code_http: r.status, type, octets: buf.byteLength };
    }
    const txt = new TextDecoder().decode(buf).slice(0, 300);
    const m = txt.match(/<ServiceException[^>]*>([\s\S]{0,200})/);
    return {
      image: false, code_http: r.status, type,
      cause: m ? m[1].trim().replace(/\s+/g, ' ') : txt.replace(/\s+/g, ' ')
    };
  } catch (e) {
    return { image: false, cause: e.message };
  }
}

async function capabilites(res) {
  const cibles = [
    { nom: 'Geoplateforme IGN', url: `${WMS_IGN}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0` },
    { nom: 'Georisques BRGM',   url: `${WMS_RISQUES}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0` }
  ];
  const filtre = res.req && res.req.url && res.req.url.includes('filtre=')
    ? decodeURIComponent(res.req.url.split('filtre=')[1].split('&')[0]).toUpperCase() : null;

  const out = [];
  for (const c of cibles) {
    try {
      const r = await fetch(c.url, { headers: { Accept: 'application/xml' } });
      const txt = await r.text();
      let noms = Array.from(txt.matchAll(/<Name>([^<]{3,120})<\/Name>/g))
        .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);
      if (filtre) noms = noms.filter(n => n.toUpperCase().includes(filtre));
      out.push({ service: c.nom, code_http: r.status, nombre: noms.length, couches: noms.slice(0, 200) });
    } catch (e) {
      out.push({ service: c.nom, erreur: e.message });
    }
  }
  return res.status(200).json({
    horodatage: new Date().toISOString(),
    astuce: "Ajouter &filtre=PPRN pour ne garder que les couches contenant ce terme.",
    sujets_configures: Object.fromEntries(
      Object.entries(SUJETS).map(([k, s]) => [k, s.couche])),
    services: out
  });
}

// ---------------------------------------------------------------------------
async function centrer(req) {
  if (req.query.parcelle) {
    const g = await geometrieParcelle(req.query.parcelle.toString());
    if (!g.obtenu) return { obtenu: false, cause: g.cause };
    return {
      obtenu: true, centre: g.centre, anneaux: g.anneaux,
      contenance: g.contenance,
      libelle: `parcelle ${req.query.parcelle} — ${g.contenance} m²`
    };
  }
  if (req.query.latlon) {
    const p = req.query.latlon.toString().split(',').map(Number);
    if (p.length !== 2 || p.some(isNaN)) {
      return { obtenu: false, cause: 'latlon attendu : longitude,latitude' };
    }
    return {
      obtenu: true, centre: { lon: p[0], lat: p[1] }, anneaux: null,
      contenance: null, libelle: `point ${p[0]}, ${p[1]}`
    };
  }
  return {
    obtenu: false,
    cause: 'Fournir ?parcelle=INSEE-PREFIXE-SECTION-NUMERO ou ?latlon=lon,lat'
  };
}

async function geometrieParcelle(reference) {
  const m = reference.split('-');
  if (m.length !== 4) return { obtenu: false, cause: `Reference non decomposable : ${reference}` };
  const [insee, comAbs, section, numero] = m;
  const url = `${IGN_CADASTRE}?code_insee=${insee}&section=${section}&numero=${numero}&com_abs=${comAbs}&_limit=1`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = JSON.parse(await r.text());
    const t = Array.isArray(j.features) ? j.features : [];
    if (!t.length) return { obtenu: false, cause: 'Parcelle introuvable au cadastre IGN.' };
    const anneaux = extraireAnneaux(t[0].geometry);
    const pts = anneaux.flat();
    return {
      obtenu: true, anneaux,
      centre: {
        lon: pts.reduce((a, p) => a + p[0], 0) / pts.length,
        lat: pts.reduce((a, p) => a + p[1], 0) / pts.length
      },
      contenance: (t[0].properties || {}).contenance
    };
  } catch (e) {
    return { obtenu: false, cause: e.message };
  }
}

function extraireAnneaux(geom) {
  if (!geom) return [];
  const out = [];
  const parcourir = (x) => {
    if (!Array.isArray(x) || typeof x[0] === 'number') return;
    if (Array.isArray(x[0]) && typeof x[0][0] === 'number') { out.push(x); return; }
    x.forEach(parcourir);
  };
  parcourir(geom.coordinates);
  return out;
}

// Marge deduite de la contenance : le bien doit occuper une part lisible de
// l'image sans que son environnement disparaisse.
function margeAdaptee(contenance) {
  if (!contenance) return 250;
  const cote = Math.sqrt(contenance);          // cote equivalent en metres
  return Math.max(60, Math.min(1200, Math.round(cote * 2.5)));
}

function emprise(centre, marge, taille) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos(centre.lat * Math.PI / 180);
  const rapport = taille.largeur / taille.hauteur;
  const demiL = rapport >= 1 ? marge * rapport : marge;
  const demiH = rapport >= 1 ? marge : marge / rapport;
  return {
    lonMin: centre.lon - demiL / mLon, latMin: centre.lat - demiH / mLat,
    lonMax: centre.lon + demiL / mLon, latMax: centre.lat + demiH / mLat
  };
}

function getMap(service, couche, bbox, transparent) {
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
    LAYERS: couche, STYLES: '', CRS: 'EPSG:4326',
    // WMS 1.3.0 + EPSG:4326 : ordre des axes latitude, longitude.
    BBOX: `${bbox.latMin},${bbox.lonMin},${bbox.latMax},${bbox.lonMax}`,
    WIDTH: String(TAILLE.largeur), HEIGHT: String(TAILLE.hauteur),
    FORMAT: transparent ? 'image/png' : 'image/jpeg',
    TRANSPARENT: transparent ? 'TRUE' : 'FALSE'
  });
  return `${service}?${p.toString()}`;
}

// ---------------------------------------------------------------------------
function page(res, { cible, bbox, urlFond, cartes, marge, fond }) {
  const projeter = ([lon, lat]) => {
    const x = (lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin) * TAILLE.largeur;
    const y = (bbox.latMax - lat) / (bbox.latMax - bbox.latMin) * TAILLE.hauteur;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const traces = (cible.anneaux || [])
    .map(a => `<polygon points="${a.map(projeter).join(' ')}" fill="#A0104022" stroke="#A01040" stroke-width="2"/>`)
    .join('');
  const repere = cible.anneaux ? '' :
    `<circle cx="${TAILLE.largeur / 2}" cy="${TAILLE.hauteur / 2}" r="4" fill="#A01040"/>`;

  const vignettes = cartes.map(c => `
    <figure>
      <figcaption>
        <span class="t">${echapper(c.titre)}</span>
        ${c.ial ? `<span class="ial">R.125-23 ${c.ial}</span>` : ''}
        <span class="c">${echapper(c.couche)}</span>
      </figcaption>
      <div class="cadre">
        <img src="${echapper(urlFond)}" alt="">
        <img src="${echapper(c.url)}" alt="" class="sur" loading="lazy">
        <svg viewBox="0 0 ${TAILLE.largeur} ${TAILLE.hauteur}" xmlns="http://www.w3.org/2000/svg">${traces}${repere}</svg>
      </div>
    </figure>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>RISQUES — cartographie par sujet</title>
<style>
  :root { --nuit:#0F2238; --canard:#33838B; --gris:#657D96; --carmin:#A01040; }
  body { font-family: Georgia, serif; margin:0; padding:26px; background:#F4F6F8; color:var(--nuit); }
  h1 { font-size:19px; margin:0 0 4px; }
  p.ref { font-family:system-ui,sans-serif; font-size:13px; color:var(--gris); margin:0 0 6px; }
  p.aide { font-family:system-ui,sans-serif; font-size:12px; color:var(--gris); margin:0 0 22px; }
  a { color:var(--canard); }
  .grille { display:grid; grid-template-columns:repeat(auto-fill,minmax(${TAILLE.largeur}px,1fr)); gap:26px; }
  figure { margin:0; }
  figcaption { font-family:system-ui,sans-serif; font-size:13px; margin-bottom:6px;
               display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
  figcaption .t { font-weight:600; }
  figcaption .ial { background:var(--nuit); color:#FFE764; font-size:10.5px;
                    padding:1px 6px; border-radius:3px; }
  figcaption .c { color:var(--gris); font-size:11px; font-family:ui-monospace,monospace; }
  .cadre { position:relative; width:100%; aspect-ratio:${TAILLE.largeur}/${TAILLE.hauteur};
           border:1px solid var(--gris); background:#fff; overflow:hidden; }
  .cadre img, .cadre svg { position:absolute; inset:0; width:100%; height:100%; }
  .cadre img.sur { opacity:.6; }
</style></head><body>
  <h1>Cartographie par sujet</h1>
  <p class="ref">${echapper(cible.libelle)} — emprise ${marge * 2} m — fond ${echapper(fond)} — centre ${cible.centre.lon.toFixed(6)}, ${cible.centre.lat.toFixed(6)}</p>
  <p class="aide">
    Une carte vide peut signifier deux choses : la rubrique ne concerne pas le bien, ou le nom
    de couche est errone. Le sondage tranche —
    <a href="?parcelle=${encodeURIComponent(new URLSearchParams(res.req?.url?.split('?')[1] || '').get('parcelle') || '')}&amp;mode=sondage">verifier les couches</a>.
    Marge adaptee a la contenance ; forcer avec <code>&amp;marge=</code>. Fond : <code>&amp;fond=ortho</code>.
  </p>
  <div class="grille">${vignettes}</div>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function echapper(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
