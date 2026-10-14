-- RISQUES — migration 001 (13/10/2026) : travaux de PORTEFEUILLE en mode différé.
-- Idempotente. À passer dans la base Neon de la suite (neondb).
--
-- Arbitrages appliqués (14 et 16/09/2026) : l'appelant (MARTEAU) envoie la liste des
-- parcelles et reçoit un NUMÉRO DE TRAVAIL ; RISQUES moissonne à son rythme ; c'est
-- l'appelant qui INTERROGE l'adresse du travail jusqu'à réponse (RISQUES ne rappelle
-- jamais) ; l'adresse du rapport expire à TRENTE JOURS.
-- Choix technique validé par JFD le 13/10/2026 : chaque interrogation fait avancer le
-- travail d'une tranche (une fonction ne vit que 60 s) ; l'état est gardé ici ; les PDF
-- sont déposés dans le stockage de fichiers de Vercel.

CREATE TABLE IF NOT EXISTS risques_travail (
  id           text PRIMARY KEY,
  cree_le      timestamptz NOT NULL DEFAULT now(),
  maj_le       timestamptz NOT NULL DEFAULT now(),
  statut       text NOT NULL DEFAULT 'en_cours',   -- en_cours | termine | echec | expire
  societe      text,
  appelant     text,
  dossier      text,
  etat         jsonb NOT NULL,                     -- phase, parcelles, résultats, biens, sections
  rapport_url  text,
  erps         jsonb,
  fichiers     jsonb NOT NULL DEFAULT '[]'::jsonb, -- adresses déposées (effacées à l'expiration)
  expire_le    timestamptz,
  verrou       timestamptz,                        -- une seule tranche à la fois
  erreur       text
);
CREATE INDEX IF NOT EXISTS risques_travail_expire ON risques_travail (expire_le) WHERE statut = 'termine';
