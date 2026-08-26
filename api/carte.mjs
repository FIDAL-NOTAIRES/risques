// RISQUES — /api/carte.mjs
//
// Cartographie du bien. Etape 1 : rendu visible immediatement, sans dependance.
//
// POURQUOI CETTE ETAPE
// L'assemblage du PDF suppose pdf-lib, donc un package.json et un npm install.
// Avant d'y revenir, cet endpoint etablit que les sources cartographiques
// repondent et que le calage sur la parcelle est juste. Il rend une page HTML :
// fond de plan en image WMS, contour de la parcelle en vecteur SVG par-dessus,
// et couches de risque en surimpression. Les memes URL serviront ensuite au PDF.
//
// SOURCES
//   Geoplateforme IGN (data.geopf.fr) : fond de plan et orthophotographie, WMS
//   raster, sans cle. Noms de couches A CONFIRMER par GetCapabilities.
//   Georisques : couches de risque en WMS. Noms A CONFIRMER de meme.
//
// Les noms de couches ci-dessous sont des hypotheses. Le mode capabilities les
// verifie : un nom errone se traduit par une image vide ou une exception XML,
// jamais par un plantage. Meme methode que pour les chemins d'API.
//
// Usage :
//   /api/carte?parcelle=37261-000-AB-0001        page HTML avec la carte
//   /api/carte?latlon=0.6848,47.3900             centrage direct
//   /api/carte?mode=capabilities                 liste les couches disponibles
//   /api/carte?...&fond=ortho                    orthophotographie
//   /api/carte?...&json=1                        les URL sans la page HTML

const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';
const WMS_IGN = 'https://data.geopf.fr/wms-r';
const WMS_RISQUES = 'https://mapsref.brgm.fr/wxs/georisques/risques';

const FONDS = {
  plan:  'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2',
  ortho: 'ORTHOIMAGERY.ORTHOPHOTOS',
  scan:  'GEOGRAPHICALGRIDSYSTEMS.MAPS'
};

// Couches de risque candidates, a confirmer.
const SURIMPRESSIONS = {
  ppr:     'ALEAS_PPRN',
  argile:  'ALEARG_S_FR',
  sismique: 'SIS_ZONAGE_SISMIQUE',
  radon:   'RADON_COMMUNE'
};

const TAILLE = { largeur: 900, hauteur: 650 };

export default async function handler(req, res) {
  const mode = req.query.mode ? req.query.mode.toString() : 'carte';

  if (mode === 'capabilities') return capabilites(res);

  // --- Centrage ---------------------------------------------------------
  let centre = null, contour = null, libelle = null;

  if (req.query.parcelle) {
    const g = await geometrieParcelle(req.query.parcelle.toString());
    if (!g.obtenu) {
      return res.status(200).json({ resultat: 'ECHEC', geometrie: g });
    }
    contour = g.anneaux;
    centre = g.centre;
    libelle = `parcelle ${req.query.parcelle} — ${g.contenance} m²`;
  } else if (req.query.latlon) {
    const p = req.query.latlon.toString().split(',').map(Number);
    if (p.length !== 2 || p.some(isNaN)) {
      return res.status(400).json({ resultat: 'ECHEC', cause: 'latlon attendu : longitude,latitude' });
    }
    centre = { lon: p[0], lat: p[1] };
    libelle = `point ${p[0]}, ${p[1]}`;
  } else {
    return res.status(400).json({
      resultat: 'ECHEC',
      cause: 'Fournir ?parcelle=INSEE-PREFIXE-SECTION-NUMERO ou ?latlon=lon,lat',
      exemples: [
        '/api/carte?parcelle=62160-000-XM-0307',
        '/api/carte?latlon=0.6848,47.3900',
        '/api/carte?mode=capabilities'
      ]
    });
  }

  // --- Emprise ----------------------------------------------------------
  // Marge autour du bien. Par defaut 250 m de part et d'autre, soit une
  // emprise de 500 m qui correspond au rayon retenu pour la pollution des sols.
  const marge = Math.max(50, Math.min(5000, parseInt(req.query.marge || '250', 10)));
  const bbox = emprise(centre, marge, TAILLE);

  const fond = FONDS[req.query.fond] || FONDS.plan;
  const urlFond = getMap(WMS_IGN, fond, bbox, false);

  const couches = {};
  for (const [nom, couche] of Object.entries(SURIMPRESSIONS)) {
    couches[nom] = getMap(WMS_RISQUES, couche, bbox, true);
  }

  if (req.query.json === '1') {
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      libelle, centre, bbox, taille: TAILLE, marge_metres: marge,
      fond_de_plan: urlFond,
      surimpressions: couches,
      contour_parcelle: contour ? `${contour.length} anneau(x)` : null,
      avertissement: "Noms de couches a confirmer : voir ?mode=capabilities."
    });
  }

  return page(res, { libelle, bbox, urlFond, couches, contour, centre, marge });
}

// ---------------------------------------------------------------------------
async function capabilites(res) {
  const cibles = [
    { nom: 'Geoplateforme IGN', url: `${WMS_IGN}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0` },
    { nom: 'Georisques BRGM',   url: `${WMS_RISQUES}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0` }
  ];

  const out = [];
  for (const c of cibles) {
    try {
      const r = await fetch(c.url, { headers: { Accept: 'application/xml' } });
      const txt = await r.text();
      // Extraction sommaire des noms de couches, sans analyseur XML.
      const noms = Array.from(txt.matchAll(/<Name>([^<]{3,120})<\/Name>/g))
        .map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i);
      out.push({
        service: c.nom, url: c.url, code_http: r.status,
        octets: txt.length,
        nombre_de_couches: noms.length,
        couches: noms.slice(0, 120)
      });
    } catch (e) {
      out.push({ service: c.nom, url: c.url, erreur: e.message });
    }
  }

  return res.status(200).json({
    horodatage: new Date().toISOString(),
    objet: 'Inventaire des couches WMS disponibles',
    methode: "Extraction des balises Name du GetCapabilities, sans analyseur XML : la liste peut contenir des noms de groupes en plus des couches.",
    hypotheses_en_place: { fonds: FONDS, surimpressions: SURIMPRESSIONS },
    services: out
  });
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
    if (!t.length) return { obtenu: false, cause: 'Parcelle introuvable au cadastre IGN.' };

    const anneaux = extraireAnneaux(t[0].geometry);
    const pts = anneaux.flat();
    const centre = {
      lon: pts.reduce((a, p) => a + p[0], 0) / pts.length,
      lat: pts.reduce((a, p) => a + p[1], 0) / pts.length
    };
    return {
      obtenu: true, anneaux, centre,
      contenance: (t[0].properties || {}).contenance
    };
  } catch (e) {
    return { obtenu: false, cause: e.message };
  }
}

function extraireAnneaux(geom) {
  if (!geom) return [];
  const out = [];
  const parcourir = (x, profondeur) => {
    if (!Array.isArray(x)) return;
    if (typeof x[0] === 'number') return;
    if (Array.isArray(x[0]) && typeof x[0][0] === 'number') { out.push(x); return; }
    x.forEach(e => parcourir(e, profondeur + 1));
  };
  parcourir(geom.coordinates, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Emprise en degres, calee sur le rapport de forme de l'image pour eviter
// toute deformation. Un degre de latitude vaut environ 111 320 m ; un degre de
// longitude, autant multiplie par le cosinus de la latitude.
// ---------------------------------------------------------------------------
function emprise(centre, marge, taille) {
  const mParDegreLat = 111320;
  const mParDegreLon = 111320 * Math.cos(centre.lat * Math.PI / 180);

  const rapport = taille.largeur / taille.hauteur;
  let demiLargeurM = marge, demiHauteurM = marge;
  if (rapport >= 1) demiLargeurM = marge * rapport;
  else demiHauteurM = marge / rapport;

  const dLon = demiLargeurM / mParDegreLon;
  const dLat = demiHauteurM / mParDegreLat;

  return {
    lonMin: centre.lon - dLon, latMin: centre.lat - dLat,
    lonMax: centre.lon + dLon, latMax: centre.lat + dLat
  };
}

function getMap(service, couche, bbox, transparent) {
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap',
    LAYERS: couche, STYLES: '',
    CRS: 'EPSG:4326',
    // En WMS 1.3.0 avec EPSG:4326, l'ordre des axes est latitude, longitude.
    BBOX: `${bbox.latMin},${bbox.lonMin},${bbox.latMax},${bbox.lonMax}`,
    WIDTH: String(TAILLE.largeur), HEIGHT: String(TAILLE.hauteur),
    FORMAT: transparent ? 'image/png' : 'image/jpeg',
    TRANSPARENT: transparent ? 'TRUE' : 'FALSE'
  });
  return `${service}?${p.toString()}`;
}

// ---------------------------------------------------------------------------
function page(res, { libelle, bbox, urlFond, couches, contour, centre, marge }) {
  const projeter = ([lon, lat]) => {
    const x = (lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin) * TAILLE.largeur;
    const y = (bbox.latMax - lat) / (bbox.latMax - bbox.latMin) * TAILLE.hauteur;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const traces = (contour || [])
    .map(a => `<polygon points="${a.map(projeter).join(' ')}" fill="#A0104022" stroke="#A01040" stroke-width="2.5"/>`)
    .join('\n      ');

  const options = Object.entries(couches).map(([nom, url]) =>
    `<label><input type="checkbox" data-url="${echapper(url)}"> ${nom}</label>`).join('\n      ');

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>RISQUES — cartographie</title>
<style>
  body { font-family: Georgia, serif; margin: 0; padding: 24px; background: #F4F6F8; color: #0F2238; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.ref { font-family: system-ui, sans-serif; font-size: 13px; color: #657D96; margin: 0 0 16px; }
  .cadre { position: relative; width: ${TAILLE.largeur}px; height: ${TAILLE.hauteur}px;
           border: 1px solid #657D96; background: #fff; }
  .cadre img, .cadre svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .barre { font-family: system-ui, sans-serif; font-size: 13px; margin: 14px 0;
           display: flex; gap: 18px; flex-wrap: wrap; align-items: center; }
  .barre label { display: flex; gap: 5px; align-items: center; }
  .note { font-family: system-ui, sans-serif; font-size: 12px; color: #657D96;
          max-width: ${TAILLE.largeur}px; margin-top: 14px; line-height: 1.5; }
  code { background: #E8ECF0; padding: 1px 4px; border-radius: 3px; }
</style></head><body>
  <h1>Cartographie du bien</h1>
  <p class="ref">${echapper(libelle)} — emprise de ${marge * 2} m — centre ${centre.lon.toFixed(6)}, ${centre.lat.toFixed(6)}</p>

  <div class="barre">
    <strong>Surimpressions :</strong>
      ${options}
  </div>

  <div class="cadre" id="cadre">
    <img src="${echapper(urlFond)}" alt="fond de plan">
    <svg viewBox="0 0 ${TAILLE.largeur} ${TAILLE.hauteur}" xmlns="http://www.w3.org/2000/svg">
      ${traces || '<!-- aucun contour : centrage par point -->'}
      <circle cx="${TAILLE.largeur / 2}" cy="${TAILLE.hauteur / 2}" r="4" fill="#A01040"/>
    </svg>
  </div>

  <p class="note">
    Le contour en carmin est la geometrie cadastrale reelle, projetee sur l'emprise du fond de plan :
    s'il ne coincide pas avec le parcellaire visible, le calage est faux et il faut le corriger avant
    d'aller plus loin. Les surimpressions reposent sur des noms de couches non confirmes ; une case
    cochee sans effet signale un nom errone. Appeler <code>?mode=capabilities</code> pour l'inventaire
    reel des couches.
  </p>

<script>
  const cadre = document.getElementById('cadre');
  document.querySelectorAll('input[type=checkbox]').forEach(c => {
    c.addEventListener('change', () => {
      const cle = 'sur-' + c.parentNode.textContent.trim();
      const existant = cadre.querySelector('[data-cle="' + cle + '"]');
      if (existant) { existant.remove(); return; }
      const img = document.createElement('img');
      img.src = c.dataset.url;
      img.dataset.cle = cle;
      img.style.opacity = '0.55';
      cadre.insertBefore(img, cadre.querySelector('svg'));
    });
  });
</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}

function echapper(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
