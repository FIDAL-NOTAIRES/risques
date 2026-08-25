// RISQUES — /api/test.js
// Endpoint de diagnostic. Valide en un appel :
//   1. la presence de la variable d'environnement GEORISQUES_TOKEN
//   2. la construction du header d'authentification
//   3. la declaration de l'endpoint dans vercel.json (sinon 404 NOT_FOUND)
//   4. la reponse effective de l'API Georisques v2
//
// Le jeton n'est JAMAIS renvoye au client. Seule sa presence et sa longueur
// sont exposees, a des fins de diagnostic.
//
// Usage :
//   /api/test
//   /api/test?parcelle=622000000XM0307
//   /api/test?insee=62160
//   /api/test?rubrique=radon

const BASE_V2 = 'https://www.georisques.gouv.fr/api/v2';
const BASE_V1 = 'https://www.georisques.gouv.fr/api/v1';

// Rubriques de diagnostic. Les chemins sont a confirmer contre le swagger
// officiel : ce fichier sert precisement a les eprouver un par un.
const RUBRIQUES = {
  radon:      { path: '/gasp/radon',                param: 'insee' },
  sismique:   { path: '/gasp/zonage_sismique',      param: 'insee' },
  catnat:     { path: '/gaspar/catnat',             param: 'insee' },
  ppr:        { path: '/gaspar/gaspar',             param: 'insee' },
  icpe:       { path: '/installations_classees',    param: 'insee' },
  casias:     { path: '/sis',                       param: 'insee' }
};

// Parcelle de reference : 000-XM-307, 62200 Boulogne-sur-Mer.
// Format attendu par l'API : code INSEE + prefixe + section + numero.
const DEFAULTS = {
  parcelle: '622000000XM0307',
  insee: '62160'
};

export default async function handler(req, res) {
  const started = Date.now();

  const token = process.env.GEORISQUES_TOKEN;
  const rubrique = (req.query.rubrique || 'radon').toString();
  const insee = (req.query.insee || DEFAULTS.insee).toString();
  const parcelle = (req.query.parcelle || DEFAULTS.parcelle).toString();

  const diagnostic = {
    horodatage: new Date().toISOString(),
    endpoint_atteint: true,
    jeton: {
      present: Boolean(token),
      longueur: token ? token.length : 0
    },
    rubriques_disponibles: Object.keys(RUBRIQUES)
  };

  if (!token) {
    return res.status(500).json({
      ...diagnostic,
      resultat: 'ECHEC',
      cause: "Variable d'environnement GEORISQUES_TOKEN absente.",
      remede: [
        'Vercel > projet risques > Settings > Environment Variables',
        'Cle : GEORISQUES_TOKEN (aucun prefixe NEXT_PUBLIC_ ni VITE_)',
        'Cocher Production, Preview et Development',
        'Puis REDEPLOYER : une variable ajoutee apres un deploiement',
        "n'est pas prise en compte par celui-ci."
      ]
    });
  }

  const cible = RUBRIQUES[rubrique];
  if (!cible) {
    return res.status(400).json({
      ...diagnostic,
      resultat: 'ECHEC',
      cause: `Rubrique inconnue : ${rubrique}`
    });
  }

  const params = new URLSearchParams();
  params.set('code_insee', insee);
  params.set('page', '1');
  params.set('page_size', '10');

  const urlV2 = `${BASE_V2}${cible.path}?${params.toString()}`;

  try {
    const reponse = await fetch(urlV2, {
      method: 'GET',
      headers: {
        // Le jeton part dans le header, jamais dans l'URL.
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    const brut = await reponse.text();
    let donnees = null;
    let json_valide = false;
    try {
      donnees = JSON.parse(brut);
      json_valide = true;
    } catch (e) {
      donnees = brut.slice(0, 800);
    }

    // Appel de recoupement v1, sans jeton, pour distinguer un probleme
    // d'authentification d'une indisponibilite du service.
    let recoupement_v1 = null;
    try {
      const r1 = await fetch(`${BASE_V1}${cible.path}?code_insee=${insee}`, {
        headers: { 'Accept': 'application/json' }
      });
      recoupement_v1 = { statut: r1.status, joignable: true };
    } catch (e) {
      recoupement_v1 = { joignable: false, erreur: e.message };
    }

    const lecture = interpreter(reponse.status);

    return res.status(200).json({
      ...diagnostic,
      resultat: reponse.ok ? 'SUCCES' : 'ECHEC',
      appel: {
        rubrique,
        url_appelee: urlV2,
        code_http: reponse.status,
        json_valide: json_valide,
        duree_ms: Date.now() - started
      },
      lecture,
      recoupement_v1,
      parcelle_reference: parcelle,
      extrait: json_valide ? extraire(donnees) : donnees
    });

  } catch (erreur) {
    return res.status(502).json({
      ...diagnostic,
      resultat: 'ECHEC',
      cause: "L'appel a Georisques a echoue avant reponse.",
      detail: erreur.message,
      duree_ms: Date.now() - started
    });
  }
}

function interpreter(code) {
  if (code === 200) return 'Chaine complete validee : jeton, header et endpoint.';
  if (code === 401) return 'Jeton refuse. Verifier sa validite et le schema du header (Bearer).';
  if (code === 403) return 'Acces interdit. Le jeton est peut-etre valide mais non habilite sur cette rubrique.';
  if (code === 404) return "Chemin inconnu cote Georisques. Corriger le chemin dans RUBRIQUES d'apres le swagger.";
  if (code === 429) return 'Quota depasse. Espacer les appels ou traiter par lots.';
  if (code >= 500) return 'Erreur cote Georisques. Reessayer avant de conclure.';
  return `Code inattendu : ${code}`;
}

function extraire(donnees) {
  if (!donnees) return null;
  if (Array.isArray(donnees)) {
    return { type: 'tableau', total: donnees.length, premier: donnees[0] || null };
  }
  if (donnees.data && Array.isArray(donnees.data)) {
    return {
      type: 'enveloppe',
      total_annonce: donnees.total ?? null,
      nombre_recu: donnees.data.length,
      premier: donnees.data[0] || null
    };
  }
  return { type: 'objet', cles: Object.keys(donnees).slice(0, 20) };
}
