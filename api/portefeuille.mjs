// Bibliothèque des phrases pré-écrites — LA source, versionnée avec le
// code. La base ne garde que le code du bloc et les valeurs à substituer
// (marteau_voyant.phrase_code, marteau_voyant.precisions).
//
// Pourquoi ici et pas en base : c'est une bibliothèque FIXE, sans
// génération libre (mémo § 7.1). Un texte modifiable sans revue serait
// une phrase modifiable sans que personne le voie. Ici, toute retouche
// passe par un commit.
//
// Chaque bloc porte : la famille (1-10), le voyant de cette famille, la
// couleur, et le texte. Les crochets {nom} sont substitués par les
// précisions du voyant. Une précision manquante laisse le crochet
// visible — VOLONTAIREMENT : un rapport avec « [précision] » se voit à
// la relecture, un rapport avec un trou ne se voit pas.
//
// Règle du 04/09/2026 : jamais un simple « aucun élément relevé ». Quand
// une vérification n'a pas pu être faite, la RAISON est dans la phrase.

export const PHRASES = {
  // ---------------------------------------------------- 1. identité
  identite_canard: { famille: 1, voyant: 'identite', couleur: 'canard',
    texte: "L'identité de la société propriétaire a été vérifiée sur la base de l'extrait K-bis obtenu par l'étude et des données du registre national des entreprises. Dénomination, SIREN, forme sociale, siège et représentation légale sont concordants." },
  identite_attente: { famille: 1, voyant: 'identite', couleur: 'jaune',
    texte: "La vérification de l'identité de la société est en cours, dans l'attente de la réception de l'extrait K-bis sollicité par l'étude à la date du {date}." },
  // Variante SANS DATE (08/11/2026) : le K-bis n'a pas de ligne au
  // registre des pièces, aucune date de demande n'est donc connue. Dater
  // la phrase du jour de l'analyse affirmait une diligence non faite.
  identite_a_solliciter: { famille: 1, voyant: 'identite', couleur: 'jaune',
    texte: "La vérification de l'identité de la société est en cours, dans l'attente de l'extrait K-bis, à obtenir par l'étude." },
  identite_procedure: { famille: 1, voyant: 'identite', couleur: 'orange',
    texte: "L'extrait K-bis fait apparaître une procédure ou une formalité en cours — {precision} — dont l'incidence sur la capacité de la société à disposer du bien reste à analyser." },
  identite_discordance: { famille: 1, voyant: 'identite', couleur: 'carmin',
    texte: "Une discordance est relevée entre la société désignée comme propriétaire au titre et la société immatriculée sous le SIREN {siren}." },
  identite_cessee: { famille: 1, voyant: 'identite', couleur: 'orange',
    texte: "La société auditée est déclarée cessée au registre national des entreprises. Sa capacité à disposer du bien est en cause : l'opération suppose d'identifier l'entité qui lui a succédé et de vérifier la publication du transfert de propriété." },
  identite_absorbee: { famille: 1, voyant: 'identite', couleur: 'carmin',
    texte: "La société auditée est déclarée cessée au registre national des entreprises, et le BODACC désigne {absorbante} (SIREN {siren}) comme société absorbante. Les biens publiés au nom de la société auditée relèvent aujourd'hui d'une autre personne morale : le vendeur au titre n'est plus la société immatriculée." },
  identite_denominations: { famille: 1, voyant: 'identite', couleur: 'orange',
    texte: "La société a été publiée sous {nombre} dénomination(s) successive(s) au BODACC — {denominations}. Chacune est à interroger au fichier immobilier : des biens peuvent rester publiés sous un nom antérieur." },
  rbe_canard: { famille: 1, voyant: 'rbe', couleur: 'canard',
    texte: "La composition des bénéficiaires effectifs déclarée par la société tête de groupe est identique à celle déclarée par les sociétés terminales du périmètre." },
  rbe_divergence: { famille: 1, voyant: 'rbe', couleur: 'orange',
    texte: "La composition des bénéficiaires effectifs déclarée par la société tête de groupe diverge de celle déclarée par {societe} : une branche du périmètre n'a peut-être pas été identifiée." },

  // ------------------------------------------------- 2. désignation
  designation_canard: { famille: 2, voyant: 'designation', couleur: 'canard',
    texte: "La désignation du bien reprend celle du titre de propriété, recoupée avec les données cadastrales et la base nationale des bâtiments, sans divergence relevée." },
  designation_attente_titre: { famille: 2, voyant: 'designation', couleur: 'jaune',
    texte: "La désignation est établie sur les seules données cadastrales — {parcelles} parcelles sur {communes} communes, {contenance} — dans l'attente de la communication du titre de propriété permettant le recoupement." },
  designation_divergence: { famille: 2, voyant: 'designation', couleur: 'orange',
    texte: "La désignation figurant au titre diverge des données cadastrales — {precision} — sans que cette divergence soit à ce stade expliquée." },
  designation_muette: { famille: 2, voyant: 'designation', couleur: 'orange',
    texte: "La désignation n'a pu être recoupée, le service cadastral ou la base nationale des bâtiments n'ayant pas répondu à la date de génération du présent audit." },
  // AJOUTÉ le 11/09/2026. La descente sur les filiales (mémo § 4.4) fait
  // entrer dans le périmètre les parcelles publiées au nom des sociétés
  // liées. Sans ce bloc, les agrégats de `designation_attente_titre`
  // additionnaient les patrimoines de plusieurs personnes morales et la
  // désignation devenait fausse — un rapport aurait porté 3 828 parcelles
  // au compte d'une société qui n'en publie que 1 636.
  //
  // La phrase NE DIT PAS que ces parcelles sont au vendeur : elle dit
  // d'où elles viennent et ce qui reste à vérifier. C'est le pendant de
  // la réserve « divergence entre le portefeuille déclaré et l'état
  // résultant des bases publiques ».
  // AJOUTÉ le 11/10/2026 (arbitrage JFD) : filiation cadastrale lue dans
  // HISTO. JAUNE et jamais plus : la documentation cadastrale n'est qu'un
  // appui, c'est l'état hypothécaire qui fait foi. La phrase ne conclut pas
  // à une erreur du titre, elle désigne ce qu'il faut y vérifier.
  designation_mouvement_cadastral: { famille: 2, voyant: 'designation', couleur: 'jaune',
    texte: "Selon la documentation cadastrale, {nombre} parcelle(s) de la société auditée sont issues d'un mouvement cadastral (division, réunion ou remaniement) intervenu au cours des trente dernières années — {detail}. Il conviendra de vérifier que le titre de propriété vise ces parcelles sous leur référence actuelle, l'état hypothécaire faisant foi de leur filiation." },
  designation_perimetre_elargi: { famille: 2, voyant: 'designation', couleur: 'orange',
    texte: "Le périmètre examiné comprend en outre {autres} parcelle(s) publiées au nom d'une ou plusieurs autres personnes morales — {detail}. Ces parcelles n'entrent pas dans la désignation du bien de la société auditée : leur rattachement au périmètre résulte des liens relevés au BODACC, et le transfert de propriété reste à vérifier parcelle par parcelle au fichier immobilier." },

  // -------------------------------------------------- 3. propriété
  propriete_canard: { famille: 3, voyant: 'origine', couleur: 'canard',
    texte: "L'origine de propriété a été vérifiée sur les trente dernières années. La société auditée est propriétaire du bien en vertu d'un acte du {date}, publié au service de la publicité foncière." },
  propriete_attente: { famille: 3, voyant: 'origine', couleur: 'jaune',
    texte: "L'analyse de l'origine de propriété est en cours, dans l'attente de la communication du titre et du résultat de l'analyse trentenaire." },
  propriete_discontinuite: { famille: 3, voyant: 'origine', couleur: 'orange',
    texte: "L'origine de propriété présente une discontinuité — {precision} — dont la régularisation reste à examiner." },
  propriete_sans_titre: { famille: 3, voyant: 'origine', couleur: 'carmin',
    texte: "La société auditée ne justifie pas d'un titre de propriété publié sur le bien." },
  cadastre_pf_divergence: { famille: 3, voyant: 'cadastre_pf', couleur: 'orange',
    texte: "Le propriétaire figurant au cadastre diverge de celui résultant du titre, sans incidence sur la propriété mais avec un impact possible sur la fiscalité locale." },

  // ----------------------------------------- 4. organisation ensemble
  organisation_attente: { famille: 4, voyant: 'regime', couleur: 'jaune',
    texte: "L'analyse est en cours, dans l'attente du règlement de copropriété, de l'état descriptif de division et des procès-verbaux d'assemblée générale des trois derniers exercices." },
  organisation_canard: { famille: 4, voyant: 'regime', couleur: 'canard',
    texte: "Les documents de l'ensemble immobilier ont été examinés. Aucun élément n'affecte la jouissance ou la cessibilité du lot." },
  organisation_gestion: { famille: 4, voyant: 'gestion', couleur: 'orange',
    texte: "Les documents de la copropriété font apparaître {precision} : travaux votés non appelés, appels de fonds impayés ou procédure engagée contre le syndicat, dont la charge est susceptible de suivre le lot." },
  organisation_regime_incertain: { famille: 4, voyant: 'regime', couleur: 'orange',
    texte: "Le régime de l'ensemble immobilier est incertain — {precision} — la désignation du bien cédé doit être fiabilisée." },
  organisation_discordance: { famille: 4, voyant: 'regime', couleur: 'carmin',
    texte: "Le vendeur ne figure pas comme copropriétaire du lot dans les documents de la copropriété communiqués, en discordance avec le titre de propriété." },

  // ------------------------------------------------ 5. hypothécaire
  hypo_attente: { famille: 5, voyant: 'inscriptions', couleur: 'jaune',
    texte: "L'analyse est en cours, dans l'attente de la réception de l'état hypothécaire requis à la date du {date}, et de la copie des actes de prêt en cours." },
  // Variante SANS DATE : tant que l'état hypothécaire n'est pas saisi
  // dans MARTEAU, aucune réquisition n'est partie (règle du 08/11/2026).
  hypo_a_solliciter: { famille: 5, voyant: 'inscriptions', couleur: 'jaune',
    texte: "L'analyse est en cours ; l'état hypothécaire est à requérir par l'étude, et la copie des actes de prêt en cours est attendue du client." },
  hypo_canard: { famille: 5, voyant: 'inscriptions', couleur: 'canard',
    texte: "L'état hypothécaire ne révèle aucune inscription grevant le bien. Les servitudes relevées au titre ne font pas obstacle à l'opération et le bien dispose d'un accès direct à la voie publique." },
  hypo_inscriptions: { famille: 5, voyant: 'inscriptions', couleur: 'orange',
    texte: "L'état hypothécaire révèle des inscriptions en cours — {precision} — dont la mainlevée ou le remboursement reste à organiser." },
  hypo_exigibilite: { famille: 5, voyant: 'inscriptions', couleur: 'carmin',
    texte: "L'acte de prêt comporte une clause d'exigibilité anticipée en cas de cession du bien." },
  nature_droit_orange: { famille: 5, voyant: 'nature_droit', couleur: 'orange',
    texte: "La société auditée n'est titulaire que d'un droit d'occupation ou d'un droit réel démembré sur {parcelles} parcelle(s) — codes de droit {codes} — et non de la pleine propriété. La nature exacte de ce droit et sa transmissibilité sont à qualifier au titre." },
  nature_droit_canard: { famille: 5, voyant: 'nature_droit', couleur: 'canard',
    texte: "La société auditée est pleine propriétaire de l'ensemble des parcelles du périmètre selon les données cadastrales." },
  enclave_carmin: { famille: 5, voyant: 'servitudes', couleur: 'carmin',
    texte: "Le bien est enclavé, l'unité foncière constituée des parcelles contiguës appartenant au vendeur ne disposant d'aucun accès à la voie publique, sans servitude de passage constituée par titre." },

  // --------------------------------------------------- 6. urbanisme
  urba_attente: { famille: 6, voyant: 'autorisations', couleur: 'jaune',
    texte: "La vérification des autorisations d'urbanisme est en cours, dans l'attente de la réponse de la commune sollicitée à la date du {date}." },
  // Variante SANS DATE : tant que la demande à la commune n'est pas
  // marquée « demandée » dans MARTEAU (règle du 08/11/2026).
  urba_a_solliciter: { famille: 6, voyant: 'autorisations', couleur: 'jaune',
    texte: "La vérification des autorisations d'urbanisme est en cours ; la commune est à solliciter." },
  urba_canard: { famille: 6, voyant: 'autorisations', couleur: 'canard',
    texte: "Les autorisations d'urbanisme ont été confirmées par la commune. Les constructions existantes sont couvertes et l'usage constaté est conforme à la destination autorisée." },
  urba_sitadel: { famille: 6, voyant: 'autorisations', couleur: 'orange',
    texte: "Une autorisation figure à la base Sitadel — {precision} — sans confirmation de la commune ; son rattachement à la parcelle, opéré par croisement géographique, reste à vérifier." },
  urba_surface: { famille: 6, voyant: 'autorisations', couleur: 'orange',
    texte: "La surface de plancher résultant des autorisations d'urbanisme diverge de la surface figurant à la désignation du titre, sans explication à ce stade." },
  urba_usage_carmin: { famille: 6, voyant: 'usage', couleur: 'carmin',
    texte: "L'usage constaté du bien diffère de la destination fixée par l'autorisation d'urbanisme." },
  zone_attente: { famille: 6, voyant: 'zone', couleur: 'jaune',
    texte: "La vérification de l'appartenance du bien à un lotissement ou à une zone d'aménagement concerté est en cours auprès de la commune." },
  zone_cahier: { famille: 6, voyant: 'zone', couleur: 'orange',
    texte: "Le bien est inclus dans un lotissement ou une zone d'aménagement concerté dont le cahier des charges n'est pas communiqué." },
  // ATTENTION — `assurance_attente` AFFIRME que des travaux ont été
  // relevés. Elle ne peut donc servir QUE lorsqu'une source a réellement
  // rendu des autorisations. Tant que rien n'est raccordé, c'est
  // `assurance_non_verifie` qu'il faut poser : un rapport signé ne peut
  // pas énoncer un constat qui n'a pas été fait (corrigé le 09/09/2026,
  // la phrase partait sur tout dossier sans qu'aucune source soit lue).
  assurance_attente: { famille: 6, voyant: 'assurance', couleur: 'jaune',
    texte: "Des travaux soumis à autorisation ont été relevés dans les dix dernières années. La justification des assurances dommages-ouvrage et de responsabilité décennale est attendue." },
  assurance_non_verifie: { famille: 6, voyant: 'assurance', couleur: 'jaune',
    texte: "Les travaux réalisés sur le bien n'ont pas encore été recherchés par l'étude — {raison}. La justification des assurances dommages-ouvrage et de responsabilité décennale est attendue du client pour les travaux des dix dernières années." },
  assurance_canard: { famille: 6, voyant: 'assurance', couleur: 'canard',
    texte: "Aucun travail soumis à autorisation n'a été relevé dans les dix dernières années." },
  assurance_orange: { famille: 6, voyant: 'assurance', couleur: 'orange',
    texte: "Des travaux susceptibles de relever de la garantie décennale ont été réalisés sans qu'une attestation d'assurance soit produite." },

  // ------------------------------------------------- 7. diagnostics
  diag_dpe_trouve: { famille: 7, voyant: 'diagnostics', couleur: 'jaune',
    texte: "La base de l'ADEME fait apparaître un diagnostic de performance énergétique établi le {date}, portant l'étiquette {etiquette}. Le document lui-même est attendu du client." },
  diag_dpe_muet: { famille: 7, voyant: 'diagnostics', couleur: 'jaune',
    texte: "La base de l'ADEME ne comporte aucun diagnostic de performance énergétique pour ce bien. Il est demandé au client s'il a déjà mandaté un diagnostiqueur." },
  diag_liste: { famille: 7, voyant: 'diagnostics', couleur: 'jaune',
    texte: "Au regard de l'usage résultant du titre et des autorisations d'urbanisme, et de la situation du bien au regard des arrêtés préfectoraux applicables, les diagnostics suivants sont attendus du client : {liste}." },
  diag_canard: { famille: 7, voyant: 'diagnostics', couleur: 'canard',
    texte: "Le dossier de diagnostics techniques a été reçu et examiné, sans anomalie affectant l'opération." },
  diag_carmin: { famille: 7, voyant: 'diagnostics', couleur: 'carmin',
    texte: "Les diagnostics reçus révèlent une anomalie appelant un traitement préalable — {precision}." },

  // ---------------------------------------------- 8. environnement
  env_canard: { famille: 8, voyant: 'risques', couleur: 'canard',
    texte: "Les vérifications faites par l'étude à partir des bases publiques interrogées à la date du {date} concordent avec l'état des risques communiqué par le client." },
  env_attente_client: { famille: 8, voyant: 'risques', couleur: 'jaune',
    texte: "Les vérifications ont été faites par l'étude. L'état des risques du client est attendu pour recoupement." },
  env_non_verifie: { famille: 8, voyant: 'risques', couleur: 'jaune',
    texte: "Les vérifications de l'étude sur les bases publiques n'ont pas encore été faites pour ce dossier — {raison}. L'état des risques du client est attendu." },
  env_divergence: { famille: 8, voyant: 'risques', couleur: 'orange',
    texte: "L'état des risques communiqué par le client diverge des vérifications faites par l'étude — {precision}." },
  env_ppr: { famille: 8, voyant: 'risques', couleur: 'orange',
    texte: "Le bien est situé dans le périmètre d'un plan de prévention des risques — {precision} — dont les prescriptions restent à analyser." },
  env_sol: { famille: 8, voyant: 'risques', couleur: 'orange',
    texte: "Une ancienne activité industrielle est recensée sur la parcelle ou à proximité immédiate, sans qu'un état des sols ait été établi." },
  env_zone_rouge: { famille: 8, voyant: 'risques', couleur: 'carmin',
    texte: "La parcelle est située en zone rouge du plan de prévention des risques — {precision} — emportant inconstructibilité ou prescriptions lourdes." },
  bati_carmin: { famille: 8, voyant: 'bati', couleur: 'carmin',
    texte: "L'immeuble fait l'objet d'un arrêté de péril ou d'insalubrité en cours." },

  // -------------------------------------------- 9. exploitation
  exploit_attente: { famille: 9, voyant: 'exploitation', couleur: 'jaune',
    texte: "L'analyse de l'occupation est en cours, dans l'attente des baux en cours et de l'état locatif." },
  exploit_canard: { famille: 9, voyant: 'exploitation', couleur: 'canard',
    texte: "Les baux ont été examinés. Le fichier SIRENE ne fait apparaître aucun établissement domicilié à l'adresse qui serait absent de l'état locatif." },
  exploit_sirene: { famille: 9, voyant: 'exploitation', couleur: 'orange',
    texte: "Un établissement est domicilié à l'adresse du bien sans figurer à l'état locatif — {precision}." },
  exploit_sans_titre: { famille: 9, voyant: 'exploitation', couleur: 'carmin',
    texte: "Le bien est occupé sans titre, ou une clause du bail fait obstacle à la cession." },
  exploit_titularite: { famille: 9, voyant: 'exploitation', couleur: 'carmin',
    texte: "Le bail a été consenti en considération de la personne du preneur — clause d'agrément ou d'incessibilité — de sorte que sa titularité ne peut être transmise sans l'accord du bailleur ou est susceptible de résiliation en cas de cession." },
  contrats_attente: { famille: 9, voyant: 'contrats', couleur: 'jaune',
    texte: "Les contrats attachés à l'immeuble — gestion, entretien, fourniture d'énergie, abonnements — sont attendus du client." },
  contrats_canard: { famille: 9, voyant: 'contrats', couleur: 'canard',
    texte: "Les contrats attachés à l'immeuble ont été examinés. Aucune clause ne fait obstacle à la cession et aucun engagement de durée n'est à reprendre." },
  contrats_orange: { famille: 9, voyant: 'contrats', couleur: 'orange',
    texte: "Certains contrats attachés à l'immeuble comportent une durée d'engagement ou un préavis de résiliation à traiter avant la cession — {precision}." },

  // ------------------------------------------------- 10. fiscalité
  fisc_actif_attente: { famille: 10, voyant: 'actif', couleur: 'jaune',
    texte: "L'analyse du régime fiscal de l'actif est en cours, dans l'attente de la communication des titres d'acquisition et du détail des immobilisations." },
  fisc_actif_canard: { famille: 10, voyant: 'actif', couleur: 'canard',
    texte: "Le régime fiscal applicable à l'actif a été examiné au vu des titres, sans élément appelant une réserve." },
  fisc_actif_regime: { famille: 10, voyant: 'actif', couleur: 'orange',
    texte: "Le bien a été acquis sous un régime — {precision} — dont les conséquences en cas de cession restent à examiner." },
  fisc_engagement: { famille: 10, voyant: 'actif', couleur: 'orange',
    texte: "L'acte d'acquisition comporte un engagement de construire souscrit le {date}, dont l'exécution dans le délai n'est pas établie, exposant le vendeur à un redressement des droits de mutation." },
  fisc_tresor: { famille: 10, voyant: 'actif', couleur: 'orange',
    texte: "L'état hypothécaire révèle une inscription d'hypothèque légale au profit du Trésor, révélatrice d'une dette fiscale dont l'apurement reste à examiner." },
  fisc_taxe_fonciere: { famille: 10, voyant: 'actif', couleur: 'orange',
    texte: "La taxe foncière n'est acquittée que sur une partie des parcelles composant l'actif, ou sur une base ne tenant pas compte des constructions existantes. L'acquéreur doit s'attendre à une régularisation." },
  fisc_cession_attente: { famille: 10, voyant: 'cession', couleur: 'jaune',
    texte: "La détermination du régime de cession est en cours, dans l'attente des pièces sollicitées auprès de l'expert-comptable de la société : acte d'acquisition avec les frais, tableau des immobilisations et des amortissements, factures de travaux immobilisés, détail du compte 2013 en cas de fusion ou d'apport." },
  fisc_cession_canard: { famille: 10, voyant: 'cession', couleur: 'canard',
    texte: "La qualité du vendeur au regard de l'impôt sur les sociétés et de la taxe sur la valeur ajoutée a été vérifiée, le régime applicable à la cession est déterminé." },
  fisc_cession_tva: { famille: 10, voyant: 'cession', couleur: 'orange',
    texte: "La qualité du vendeur laisse subsister une incertitude sur le régime de taxe sur la valeur ajoutée applicable à la cession." },
  fisc_plus_value: { famille: 10, voyant: 'cession', couleur: 'orange',
    texte: "La valeur nette comptable de l'immeuble au bilan est sensiblement inférieure aux valeurs constatées pour les transactions comparables. L'imposition de la plus-value devra être prise en compte dans la détermination du prix net vendeur." },
};

// Rend le texte d'un bloc avec ses précisions. Un crochet sans valeur
// reste visible — c'est voulu, cf. en-tête.
export function rendre(code, precisions = {}) {
  const bloc = PHRASES[code];
  if (!bloc) return { erreur: `bloc inconnu : ${code}` };
  const texte = bloc.texte.replace(/\{(\w+)\}/g, (m, k) =>
    precisions[k] != null && precisions[k] !== '' ? String(precisions[k]) : `[${k}]`);
  return { ...bloc, code, texte };
}
