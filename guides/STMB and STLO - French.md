[Lien vers ST Memory Books (STMB)](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) | [Lien vers ST Lorebook Ordering (STLO)](https://github.com/aikohanasaki/SillyTavern-LorebookOrdering)

# 🧠 Le Guide Ultime de la Mémoire : STMB + STLO

ST Memory Books (STMB) est essentiel pour **générer du contenu mémoriel**, et ST Lorebook Ordering (STLO) est essentiel pour **garantir que ce contenu est réellement utilisé** par l'IA. Lorsqu'ils sont utilisés ensemble, ils résolvent le problème central de l'**Exclusion de Mémoire**.

## Étape 1 : Préparer le Terrain (Les Fondations)

**Forcez le mode "Sorted Evenly" (Trié Uniformément) :** Vous devez d'abord vous assurer que la configuration par défaut du *World Info* (WI) de SillyTavern est réglée pour permettre à STLO de prendre le contrôle. Dans vos **Paramètres World Info** de SillyTavern, réglez la **Stratégie d'insertion du World Info** sur **"Sorted Evenly"**. STLO nécessite cette stratégie pour contourner le tri rigide des catégories du code de base de SillyTavern (Chat  Persona  etc.).

## Étape 2 : Créer le Contenu Mémoriel (Le travail de STMB)

Utilisez STMB pour créer automatiquement vos souvenirs à long terme.

1. **Activer l'Auto-Summary (Résumé Auto) :** Allez dans le panneau STMB (la baguette magique 🪄) et activez **Auto-Summary**. Définissez votre intervalle préféré (par ex., **30 messages**).
2. **Lier/Créer un Memory Book :** Assurez-vous que votre chat dispose d'un Lorebook dédié pour les souvenirs. STMB placera généralement les souvenirs dans un livre de type *Global*, mais utilise souvent le lorebook lié au Chat (*Chat-bound*) par simplicité.
3. **Discutez Normalement :** Au fur et à mesure que votre discussion progresse, STMB génère automatiquement des résumés denses, structurés et de haute qualité. Ces souvenirs sont maintenant les "passagers" qui tentent d'embarquer sur le "vol" limité du contexte de l'IA.

## Étape 3 : Garantir la Priorité (Le travail de STLO)

C'est l'étape la plus critique. Vous devez utiliser STLO pour abaisser manuellement la priorité de votre **livre STMB lié au Chat** tout en élevant celle de vos **Essentiels du Personnage**.

### A. Briser le piège du "Chat-First"

Par défaut, un livre de mémoire lié au chat reçoit la **priorité la plus élevée** (*Chat-First*), risquant d'utiliser trop d'espace de contexte et de bloquer les autres lorebooks de Monde, de Personnage et/ou de Persona. STLO vous permet de corriger cela en réassignant un niveau de priorité personnalisé et spécifique.

### B. La Pile de Priorités Recommandée

Utilisez STLO pour définir des priorités personnalisées pour tous les lorebooks pertinents :

### Comprendre Priorité vs Position

**Position** détermine *où* le contenu apparaît dans le contexte (Char up, Char down, AN up/down, @D).
**Priorité** détermine la *protection du budget* - ce qui survit lorsque les limites de contexte sont atteintes.

Un numéro de priorité plus élevé = mieux protégé contre la troncature. La priorité fonctionne **au sein de chaque position**, pas entre les positions.

---

### Paramètres de Priorité Recommandés pour STLO

| Type de Lorebook/Mémoire | Priorité Recommandée | Justification |
| --- | --- | --- |
| **Essentiels du Personnage** (Personnalité, Description, Traits Fondamentaux) | **Priorité 5** (La plus haute) | **Protection maximale du budget.** Les informations de la carte du personnage sont la fondation de l'identité et du comportement du bot. Ce contenu ne doit jamais être tronqué sous peine de briser le personnage. La position est généralement définie par le créateur du bot (Char/AN down ou @D). |
| **Lore du Monde** (Cadre, Factions, Lieux, Règles) | **Priorité 4** (Haute, avec limites budgétaires) | **Haute protection mais contrôlable.** La construction du monde (World-building) fournit un contexte essentiel pour que le bot fonctionne correctement. Doit être budgétisé/limité pour éviter le "bloat" (gonflement), mais suffisamment protégé pour que les infos clés du monde ne soient pas perdues. Est coupé avant les essentiels du personnage si nécessaire. |
| **Persona** (Votre Identité) | **Priorité 2-3** (Moyenne) | **Protection modérée.** Les informations sur l'identité de l'utilisateur sont importantes pour des réponses personnalisées, mais le bot peut fonctionner si certains détails du persona sont élagués. Moins critique que les fondations du personnage ou du monde. |
| **Commandes/Instructions Générales** | **Priorité 2-3** (Moyenne) | **Protection modérée.** Instructions comportementales générales et commandes de formatage. Important pour la qualité de la réponse, surtout si placé en @D par le créateur du bot, mais pas aussi critique que l'intégrité du personnage. |
| **Souvenirs** (STMB, Événements Rappelés) | **Priorité 1** (La plus basse, avec limites budgétaires) | **Protection minimale, budgétisation agressive.** Les souvenirs devraient généralement être positionnés en *Char up* (tôt dans le contexte) et servir d'enrichissement plutôt que d'information essentielle. Quand de nombreux souvenirs se déclenchent, la plupart peuvent être tronqués sans risque de casser le bot. Les limites budgétaires empêchent l'accumulation de souvenirs d'évincer les informations critiques. |

---

### Principes Clés

1. **Protégez ce qui est irremplaçable** : Les essentiels du personnage ne peuvent pas être reconstruits s'ils sont perdus.
2. **Budgétisez ce qui peut gonfler** : Le lore du monde et les souvenirs peuvent déclencher des dizaines d'entrées - limitez-les.
3. **La position est distincte** : Un élément de Priorité 1 placé en @D apparaît toujours en bas ; il est simplement coupé en premier si le contexte est plein.
4. **Faites confiance au créateur du bot** : Les bots bien conçus placent leurs instructions les plus critiques en @D, quels que soient vos paramètres de priorité.

---

## C. Définir un Plafond Budgétaire (Budget Cap)

* **Essentiels du Personnage** : Pas de limite (généralement compact de toute façon)
* **Lore du Monde** : 15 000 - 25 000 tokens max
* **Persona** : Pas de limite (généralement compact)
* **Commandes/Général** : Pas de limite (généralement compact)
* **Souvenirs** : 5 000 - 15 000 tokens max (élagage agressif)

1. Ouvrez la configuration STLO pour votre lorebook STMB.
2. Définissez un plafond de **Budget** (par ex., **Fixed tokens** comme `5000`, ou **Percentage of Context** comme `15%`).
3. Cela garantit que même lorsque le lorebook est traité tôt, il se **rogne** (trims) automatiquement pour respecter votre plafond de capacité, laissant de la place pour tous les autres lorebooks de Priorité 3, 2 et 1.

