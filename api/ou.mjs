// RISQUES — /api/ou.mjs
//
// Resolution d'un point ou d'une adresse en reference cadastrale.
//
// POURQUOI
// Chercher une parcelle par son numero suppose de connaitre sa section : le
// meme numero existe dans plusieurs sections d'une commune, et rien sur le
// fond de plan ne les distingue a l'echelle utile. Partir du point est la
// bonne methode — le module cadastre d'API Carto accepte une geometrie et
// renvoie la parcelle qui la contient.
//
// Cet endpoint sert aussi le MODE D'ENTREE 2 prevu au memo v1 : saisie d'une
// adresse d'immeuble avec resolution automatique de la parcelle. La Base
// Adresse Nationale fournit le geocodage, le cadastre la parcelle.
//
// Usage :
//   /api/ou?latlon=0.6848,47.3900
//   /api/ou?adresse=12 boulevard Béranger, Tours
//   /api/ou?adresse=...&n=5           plusieurs candidats d'adresse

const BAN = 'https://api-adresse.data.gouv.fr/search';
const IGN_CADASTRE = 'https://apicarto.ign.fr/api/cadastre/parcelle';

export default async function handler(req, res) {
  const debut = Date.now();

  if (req.query.latlon) {
    const p = req.query.latlon.toString().split(',').map(Number);
    if (p.length !== 2 || p.some(isNaN)) {
      return res.status(400).json({
        resultat: 'ECHEC',
        cause: 'latlon attendu : longitude,latitude (séparateur décimal : le point)'
      });
    }
    const r = await parcelleAuPoint(p[0], p[1]);
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      point: { longitude: p[0], latitude: p[1] },
      ...r,
      duree_ms: Date.now() - debut
    });
  }

  if (req.query.adresse) {
    const n = Math.max(1, Math.min(10, parseInt(req.query.n || '3', 10)));
    const adresses = await geocoder(req.query.adresse.toString(), n);
    if (!adresses.length) {
      return res.status(200).json({
        resultat: 'ECHEC',
        cause: 'Adresse introuvable dans la Base Adresse Nationale.',
        duree_ms: Date.now() - debut
      });
    }
    const out = [];
    for (const a of adresses) {
      const r = await parcelleAuPoint(a.lon, a.lat);
      out.push({ adresse: a, ...r });
      await pause(120);
    }
    return res.status(200).json({
      horodatage: new Date().toISOString(),
      recherche: req.query.adresse.toString(),
      candidats: out,
      lecture: "Le premier candidat est celui que la Base Adresse Nationale juge le plus probable. Vérifier la commune et le numéro avant de retenir une référence.",
      duree_ms: Date.now() - debut
    });
  }

  return res.status(400).json({
    resultat: 'ECHEC',
    cause: 'Fournir ?latlon=lon,lat ou ?adresse=...',
    exemples: [
      '/api/ou?latlon=0.6848,47.3900',
      '/api/ou?adresse=12 boulevard Béranger, Tours'
    ]
  });
}

// ---------------------------------------------------------------------------
async function parcelleAuPoint(lon, lat) {
  // Le module cadastre accepte une geometrie GeoJSON : un point suffit, et
  // l'API retourne la ou les parcelles qui l'intersectent.
  const geom = JSON.stringify({ type: 'Point', coordinates: [lon, lat] });
  const url = `${IGN_CADASTRE}?geom=${encodeURIComponent(geom)}&_limit=5`;

  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (r.status !== 200) {
      return { resultat: 'ECHEC', code_http: r.status, cause: 'Le module cadastre a refusé la requête.' };
    }
    const j = await r.json();
    const traits = j.features || [];
    if (!traits.length) {
      return {
        resultat: 'ECHEC',
        cause: 'Aucune parcelle cadastrale à ce point. Domaine public, voirie ou cours d\'eau probable.'
      };
    }

    const parcelles = traits.map(f => {
      const p = f.properties || {};
      // La reference attendue par les endpoints v2 de Georisques suit le
      // format commune-prefixe-section-numero, chaque partie sur sa longueur
      // canonique : prefixe sur 3, section sur 2, numero sur 4.
      const insee = p.code_insee || p.commune || '';
      const prefixe = (p.com_abs || p.prefixe || '000').padStart(3, '0');
      const section = (p.section || '').padStart(2, '0');
      const numero = (p.numero || '').padStart(4, '0');
      return {
        reference: `${insee}-${prefixe}-${section}-${numero}`,
        commune: insee,
        section: p.section || null,
        numero: p.numero || null,
        contenance_m2: p.contenance ?? null,
        appels_suivants: {
          etat_des_risques: `/api/erp?parcelle=${insee}-${prefixe}-${section}-${numero}`,
          cartographie: `/api/carte?parcelle=${insee}-${prefixe}-${section}-${numero}`
        }
      };
    });

    return {
      resultat: 'SUCCES',
      nombre: parcelles.length,
      parcelle: parcelles[0],
      autres: parcelles.slice(1),
      remarque: parcelles.length > 1
        ? "Plusieurs parcelles intersectent ce point : il tombe vraisemblablement sur une limite."
        : null
    };
  } catch (e) {
    return { resultat: 'ECHEC', cause: e.message };
  }
}

async function geocoder(adresse, n) {
  const url = `${BAN}?q=${encodeURIComponent(adresse)}&limit=${n}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return [];
    const j = await r.json();
    return (j.features || []).map(f => ({
      libelle: f.properties.label,
      type: f.properties.type,
      commune: f.properties.city,
      code_insee: f.properties.citycode,
      score: Math.round((f.properties.score || 0) * 100) / 100,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1]
    }));
  } catch {
    return [];
  }
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
