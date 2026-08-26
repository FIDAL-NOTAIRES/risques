// api/test-jeton.js — RISQUES
// Sonde jetable : vérifie que GEORISQUES_TOKEN est bien injecté et fonctionnel.
// À SUPPRIMER une fois le test concluant (endpoint non authentifié).
//
// Usage :
//   /api/test-jeton
//   /api/test-jeton?chemin=/api/v2/gaspar/risques&code_insee=29019
//
// Le jeton n'est JAMAIS renvoyé dans la réponse : seules sa présence et sa
// longueur sont exposées.

const BASE = 'https://www.georisques.gouv.fr';

// Variantes de header à tester, dans l'ordre.
const VARIANTES = [
  { nom: 'Authorization: Bearer', entetes: (t) => ({ Authorization: `Bearer ${t}` }) },
  { nom: 'apiKey',               entetes: (t) => ({ apiKey: t }) },
  { nom: 'X-API-Key',            entetes: (t) => ({ 'X-API-Key': t }) },
  { nom: 'Authorization brut',   entetes: (t) => ({ Authorization: t }) },
];

module.exports = async (req, res) => {
  const debut = Date.now();
  const jeton = process.env.GEORISQUES_TOKEN;

  const diagnostic = {
    execution: {
      region: process.env.VERCEL_REGION || null,
      deploiement: process.env.VERCEL_GIT_COMMIT_SHA || null,
      environnement: process.env.VERCEL_ENV || null,
    },
    jeton: {
      present: Boolean(jeton),
      longueur: jeton ? jeton.length : 0,
      apercu: jeton ? `${jeton.slice(0, 4)}…${jeton.slice(-4)}` : null,
    },
  };

  if (!jeton) {
    diagnostic.verdict = 'ECHEC — variable GEORISQUES_TOKEN absente de cet environnement.';
    diagnostic.piste = `Portée manquante pour VERCEL_ENV="${process.env.VERCEL_ENV}", ou aucun redéploiement depuis l'ajout de la variable.`;
    res.status(500).json(diagnostic);
    return;
  }

  // Cible du test. Modifiable par query string pour sonder plusieurs endpoints
  // sans redéployer.
  const chemin = req.query.chemin || '/api/v2/gaspar/risques';
  const codeInsee = req.query.code_insee || '29019'; // Brest, par défaut
  const url = `${BASE}${chemin}?code_insee=${encodeURIComponent(codeInsee)}&page=1&page_size=1`;

  diagnostic.cible = { url, chemin, code_insee: codeInsee };
  diagnostic.essais = [];

  let succes = null;

  for (const variante of VARIANTES) {
    const t0 = Date.now();
    try {
      const reponse = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...variante.entetes(jeton) },
      });

      const brut = await reponse.text();
      const essai = {
        header: variante.nom,
        statut: reponse.status,
        duree_ms: Date.now() - t0,
        corps_tronque: brut.slice(0, 400),
      };

      diagnostic.essais.push(essai);

      if (reponse.ok) {
        succes = variante.nom;
        try {
          essai.corps_json = JSON.parse(brut);
          delete essai.corps_tronque;
        } catch (_) {
          // Réponse non-JSON : on garde le corps tronqué tel quel.
        }
        break;
      }
    } catch (err) {
      diagnostic.essais.push({
        header: variante.nom,
        erreur: err.message,
        duree_ms: Date.now() - t0,
      });
    }
  }

  const statuts = diagnostic.essais.map((e) => e.statut).filter(Boolean);

  if (succes) {
    diagnostic.verdict = `OK — jeton fonctionnel. Header retenu : ${succes}`;
  } else if (statuts.some((s) => s === 401 || s === 403)) {
    diagnostic.verdict = 'ECHEC — jeton rejeté (401/403). Jeton invalide, expiré, ou header incorrect.';
  } else if (statuts.some((s) => s === 404)) {
    diagnostic.verdict = `INDETERMINE — 404 sur ${chemin}. Le chemin v2 est probablement faux : réessayez avec ?chemin=…`;
  } else {
    diagnostic.verdict = 'INDETERMINE — aucune variante concluante, voir le détail des essais.';
  }

  diagnostic.duree_totale_ms = Date.now() - debut;
  res.status(succes ? 200 : 502).json(diagnostic);
};
